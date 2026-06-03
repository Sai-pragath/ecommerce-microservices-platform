document.addEventListener('DOMContentLoaded', () => {
  let token = localStorage.getItem('token');
  let socket;
  let products = [];
  
  const loginForm = document.getElementById('login-form');
  const userInfo = document.getElementById('user-info');
  const loggedUser = document.getElementById('logged-user');
  const usernameInput = document.getElementById('username');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const refillBtn = document.getElementById('refill-btn');
  const productsList = document.getElementById('products-list');
  const ordersList = document.getElementById('orders-list');
  const logsContainer = document.getElementById('logs-container');
  const connStatus = document.getElementById('connection-status');

  // UI initialization
  if (token) {
    showLoggedIn(localStorage.getItem('username') || 'User');
    initWebSocket();
    loadDashboardData();
  } else {
    showLoggedOut();
  }

  // Login handler
  loginBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    if (!username) return alert('Please enter a username');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('username', data.username);
        token = data.token;
        showLoggedIn(data.username);
        initWebSocket();
        loadDashboardData();
      } else {
        alert(data.error || 'Login failed');
      }
    } catch (err) {
      alert('Error connecting to gateway: ' + err.message);
    }
  });

  // Logout handler
  logoutBtn.addEventListener('click', () => {
    localStorage.clear();
    token = null;
    showLoggedOut();
    if (socket) socket.disconnect();
    ordersList.innerHTML = '<div class="no-orders">No orders placed yet. Log in to place your first order.</div>';
    addLog('System', 'User logged out. WebSocket closed.', 'system');
  });

  // Refill handler
  refillBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/inventory/refill', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        loadInventory();
        addLog('System', 'Inventory restocked to default limits in Redis.', 'system');
      } else {
        alert('Failed to refill inventory');
      }
    } catch (err) {
      console.error(err);
    }
  });

  function showLoggedIn(username) {
    loginForm.classList.add('hidden');
    userInfo.classList.remove('hidden');
    loggedUser.textContent = username;
  }

  function showLoggedOut() {
    loginForm.classList.remove('hidden');
    userInfo.classList.add('hidden');
    loggedUser.textContent = '';
  }

  // Load Dashboard Data
  function loadDashboardData() {
    loadInventory();
    loadOrders();
  }

  // Fetch Inventory (Public API)
  async function loadInventory() {
    try {
      const res = await fetch('/api/inventory');
      if (!res.ok) throw new Error('Failed to fetch inventory');
      products = await res.json();
      renderProducts();
    } catch (err) {
      console.error(err);
      productsList.innerHTML = `<div class="error">Inventory service offline.</div>`;
    }
  }

  // Fetch Orders (Requires JWT)
  async function loadOrders() {
    try {
      const res = await fetch('/api/orders', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch orders');
      const orders = await res.json();
      renderOrders(orders);
    } catch (err) {
      console.error(err);
    }
  }

  // Render Products
  function renderProducts() {
    productsList.innerHTML = '';
    products.forEach(p => {
      const isOut = p.stock <= 0;
      const isLow = p.stock > 0 && p.stock <= 3;
      
      let stockClass = 'stock-tag';
      if (isOut) stockClass += ' stock-empty';
      else if (isLow) stockClass += ' stock-low';

      const card = document.createElement('div');
      card.className = 'product-card';
      card.innerHTML = `
        <div class="product-details">
          <h3>${p.name}</h3>
          <p>${p.description}</p>
          <span class="${stockClass}">Stock: ${p.stock}</span>
        </div>
        <div class="product-action">
          <span class="price">$${p.price.toFixed(2)}</span>
          <button class="buy-btn" data-id="${p.id}" ${isOut ? 'disabled' : ''}>
            ${isOut ? 'Out of Stock' : 'Order Now'}
          </button>
        </div>
      `;
      productsList.appendChild(card);
    });

    // Add buy button listeners
    document.querySelectorAll('.buy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (!token) return alert('Please log in first to place orders.');
        const productId = e.target.dataset.id;
        placeOrder(productId, 1);
      });
    });
  }

  // Place Order
  async function placeOrder(productId, quantity) {
    try {
      // Trigger a brief Gateway network animation immediately
      triggerNodePulse('node-gateway', 'success');
      triggerLineActive('connector-gate-order');

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ productId, quantity })
      });
      const data = await res.json();
      if (res.ok) {
        loadOrders();
        // Decrease stock locally to make visual UI feel fast
        const pIndex = products.findIndex(p => p.id === productId);
        if (pIndex !== -1 && products[pIndex].stock > 0) {
          products[pIndex].stock -= quantity;
          renderProducts();
        }
      } else {
        alert(data.error || 'Failed to place order');
        resetTopologyEffects();
      }
    } catch (err) {
      alert('Error creating order: ' + err.message);
      resetTopologyEffects();
    }
  }

  // Render Orders
  function renderOrders(orders) {
    if (orders.length === 0) {
      ordersList.innerHTML = '<div class="no-orders">No orders placed yet.</div>';
      return;
    }
    ordersList.innerHTML = '';
    orders.forEach(o => {
      const card = document.createElement('div');
      card.className = 'order-card';
      
      const itemsText = o.items.map(item => `${item.name} (${item.quantity}x)`).join(', ');
      const dateText = new Date(o.created_at).toLocaleTimeString();
      
      card.innerHTML = `
        <div class="order-header">
          <span class="order-id">#${o.id.substring(0, 8)}</span>
          <span class="status-badge status-${o.status.toLowerCase()}">${o.status}</span>
        </div>
        <div class="order-items">${itemsText}</div>
        <div class="order-footer">
          <span>Time: ${dateText}</span>
          <span class="order-total">$${parseFloat(o.total_amount).toFixed(2)}</span>
        </div>
      `;
      ordersList.appendChild(card);
    });
  }

  // Setup WebSockets
  function initWebSocket() {
    socket = io();

    socket.on('connect', () => {
      connStatus.textContent = 'WebSockets Active';
      connStatus.className = 'status-connected';
      addLog('Gateway', 'Connected to real-time events websocket server.', 'system');
    });

    socket.on('disconnect', () => {
      connStatus.textContent = 'Disconnected';
      connStatus.className = 'status-disconnected';
    });

    socket.on('telemetry-event', (event) => {
      const { topic, payload } = event;
      
      // Log event
      addLog(topic, JSON.stringify(payload), topic.replace('.', '_'));

      // Dispatch visual flow changes based on topic
      handleTopologyAnimation(topic, payload);

      // Trigger automatic reloads to fetch up-to-date DB states
      if (topic === 'order.confirmed' || topic === 'order.failed') {
        setTimeout(loadOrders, 500);
      }
      if (topic === 'inventory.reserved' || topic === 'inventory.failed') {
        setTimeout(loadInventory, 500);
      }
    });
  }

  // Append logs
  function addLog(topic, msg, typeClass) {
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-entry ${typeClass}`;
    div.innerHTML = `
      <span class="log-time">[${time}]</span>
      <span class="log-topic">${topic.toUpperCase()}</span>
      <span class="log-msg">${msg}</span>
    `;
    logsContainer.appendChild(div);
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  // Live Visual Flow Topology Engine
  function handleTopologyAnimation(topic, payload) {
    switch (topic) {
      case 'order.placed':
        // Pulse Order Service
        triggerNodePulse('node-order', 'pulse');
        // Pulse Line from Order Service to Kafka Broker
        triggerLineActive('connector-order-kafka');
        
        // Pulse Broker (Kafka)
        setTimeout(() => {
          triggerNodePulse('node-broker', 'pulse');
        }, 300);
        break;

      case 'inventory.reserved':
        // Event flows from Kafka to Inventory Service
        triggerLineActive('connector-kafka-inventory');
        setTimeout(() => {
          triggerNodePulse('node-inventory', 'success');
        }, 200);
        break;

      case 'inventory.failed':
        triggerLineActive('connector-kafka-inventory');
        setTimeout(() => {
          triggerNodePulse('node-inventory', 'failed');
        }, 200);
        break;

      case 'payment.processed':
        // Event flows from Kafka to Payment Service
        triggerLineActive('connector-kafka-payment');
        setTimeout(() => {
          triggerNodePulse('node-payment', 'success');
          // Charge processed -> Payment publishes event back to Kafka
          triggerLineActive('connector-payment-kafka');
        }, 300);
        break;

      case 'payment.failed':
        triggerLineActive('connector-kafka-payment');
        setTimeout(() => {
          triggerNodePulse('node-payment', 'failed');
          triggerLineActive('connector-payment-kafka');
        }, 300);
        break;

      case 'notification.sent':
        // Event flows to Notification service
        triggerLineActive('connector-kafka-notification');
        setTimeout(() => {
          triggerNodePulse('node-notification', 'success');
        }, 400);
        break;

      case 'order.confirmed':
        // Kafka pushes to Order Service to confirm
        triggerLineActive('connector-kafka-order-confirm');
        setTimeout(() => {
          triggerNodePulse('node-order', 'success');
          triggerNodePulse('node-gateway', 'success');
          // Auto-clear styles after success cycle completes
          setTimeout(resetTopologyEffects, 4000);
        }, 300);
        break;

      case 'order.failed':
        triggerLineActive('connector-kafka-order-confirm');
        setTimeout(() => {
          triggerNodePulse('node-order', 'failed');
          triggerNodePulse('node-gateway', 'failed');
          setTimeout(resetTopologyEffects, 4000);
        }, 300);
        break;
    }
  }

  // Animation Helper Operations
  function triggerNodePulse(nodeId, className) {
    const node = document.getElementById(nodeId);
    if (!node) return;
    node.className = 'node'; // Reset
    void node.offsetWidth; // Reflow reset
    node.classList.add(className);
  }

  function triggerLineActive(lineId) {
    const line = document.getElementById(lineId);
    if (!line) return;
    
    // Toggle active state
    if (line.classList.contains('connector-line')) {
      line.classList.add('active-pulse');
    } else {
      line.classList.add('active');
    }
  }

  function resetTopologyEffects() {
    document.querySelectorAll('.node').forEach(n => {
      n.className = 'node';
    });
    // Restore default broker border
    document.getElementById('node-broker').classList.add('broker-node');
    
    document.querySelectorAll('.connector').forEach(c => {
      c.className = c.className.replace('active', '').trim();
    });
    document.querySelectorAll('.connector-line').forEach(cl => {
      cl.classList.remove('active-pulse');
    });
  }
});
