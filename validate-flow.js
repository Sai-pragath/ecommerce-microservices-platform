const http = require('http');

const GATEWAY_URL = 'http://localhost:3000';

async function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    if (options.body) {
      reqOptions.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function run() {
  console.log('====================================================');
  console.log('     Starting End-to-End System Verification        ');
  console.log('====================================================');

  try {
    // 1. Authenticate with JWT
    console.log('[Test] Log in as "tester_bob"...');
    const authRes = await request(`${GATEWAY_URL}/api/auth/login`, {
      method: 'POST',
      body: { username: 'tester_bob' }
    });

    if (authRes.status !== 200) {
      throw new Error(`Authentication failed with status ${authRes.status}`);
    }

    const token = authRes.body.token;
    console.log('[Test] Auth successful. Token received:', token.substring(0, 20) + '...');

    const headers = { 'Authorization': `Bearer ${token}` };

    // 2. Check initial inventory
    console.log('[Test] Fetching initial inventory...');
    const invBefore = await request(`${GATEWAY_URL}/api/inventory`);
    const cyberpunkJacketBefore = invBefore.body.find(p => p.id === 'prod-1');
    console.log(`[Test] Initial Cyberpunk Jacket stock: ${cyberpunkJacketBefore.stock}`);

    // 3. Place an order
    console.log('[Test] Placing order for 1x Cyberpunk Jacket...');
    const orderRes = await request(`${GATEWAY_URL}/api/orders`, {
      method: 'POST',
      headers,
      body: { productId: 'prod-1', quantity: 1 }
    });

    console.log('[Test] Order placed API response:', orderRes.body);
    const orderId = orderRes.body.orderId;

    // 4. Wait for processing (Payment simulation takes 1.5s)
    console.log('[Test] Sleeping for 2.5 seconds to let payment & stock processing resolve...');
    await new Promise(resolve => setTimeout(resolve, 2500));

    // 5. Verify order status has progressed to CONFIRMED or FAILED
    console.log('[Test] Fetching orders list...');
    const ordersRes = await request(`${GATEWAY_URL}/api/orders`, { headers });
    const placedOrder = ordersRes.body.find(o => o.id === orderId);
    
    console.log('[Test] Order details after processing:', placedOrder);
    if (!placedOrder) {
      throw new Error(`Order ${orderId} was not found in the orders list!`);
    }

    console.log(`[Test] Verified Order Status: ${placedOrder.status}`);

    // 6. Verify inventory stock decremented on SUCCESS, or rolled back on FAILURE
    console.log('[Test] Fetching updated inventory...');
    const invAfter = await request(`${GATEWAY_URL}/api/inventory`);
    const cyberpunkJacketAfter = invAfter.body.find(p => p.id === 'prod-1');
    console.log(`[Test] Updated Cyberpunk Jacket stock: ${cyberpunkJacketAfter.stock}`);

    if (placedOrder.status === 'CONFIRMED') {
      if (cyberpunkJacketAfter.stock === cyberpunkJacketBefore.stock - 1) {
        console.log('\x1b[32m[SUCCESS] Verification passed! Stock correctly decremented by 1.\x1b[0m');
      } else {
        console.log('\x1b[31m[FAILURE] Verification failed: Stock did not decrement correctly.\x1b[0m');
      }
    } else if (placedOrder.status === 'FAILED') {
      if (cyberpunkJacketAfter.stock === cyberpunkJacketBefore.stock) {
        console.log('\x1b[32m[SUCCESS] Verification passed! Failed payment correctly rolled back and restored stock.\x1b[0m');
      } else {
        console.log('\x1b[31m[FAILURE] Verification failed: Failed order stock rollback failed.\x1b[0m');
      }
    }

  } catch (err) {
    console.error('\x1b[31m[ERROR] Verification execution error:\x1b[0m', err.message);
  }
}

run();
