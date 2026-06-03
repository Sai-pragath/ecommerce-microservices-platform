const express = require('express');
const { Client } = require('pg');
const crypto = require('crypto');
const EventBus = require('./event-bus');

const PORT = process.env.PORT || 3001;

const PRODUCTS = {
  'prod-1': { name: 'Cyberpunk Jacket', price: 129.99 },
  'prod-2': { name: 'Holographic Glasses', price: 49.50 },
  'prod-3': { name: 'Neural Link Interface', price: 899.00 }
};

const app = express();
app.use(express.json());

// In-Memory Database Fallback Class
class MemoryDb {
  constructor() {
    this.orders = [];
  }
  async connect() {
    console.log('[Database] Using local In-Memory orders database fallback.');
  }
  async query(text, params) {
    if (text.startsWith('INSERT INTO')) {
      const [id, user_id, product_id, product_name, quantity, total_amount, status] = params;
      const order = {
        id,
        user_id,
        product_id,
        product_name,
        quantity,
        total_amount: parseFloat(total_amount),
        status,
        created_at: new Date()
      };
      this.orders.push(order);
      return { rows: [order] };
    }
    if (text.startsWith('SELECT * FROM orders WHERE user_id')) {
      const [userId] = params;
      const rows = this.orders.filter(o => o.user_id === userId);
      rows.sort((a, b) => b.created_at - a.created_at);
      return { rows };
    }
    if (text.startsWith('UPDATE orders SET status')) {
      const [status, orderId] = params;
      const order = this.orders.find(o => o.id === orderId);
      if (order) {
        order.status = status;
      }
      return { rows: order ? [order] : [] };
    }
    return { rows: [] };
  }
}

// Database Selector
let db;
const pgClient = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'ecommerce_user',
  password: process.env.DB_PASSWORD || 'ecommerce_password',
  database: process.env.DB_NAME || 'ecommerce_db'
});

async function connectDatabase(retries = 5, delay = 2000) {
  // If DB_HOST is set, try to connect to PG, else immediately use mock db.
  if (!process.env.DB_HOST) {
    db = new MemoryDb();
    await db.connect();
    return;
  }

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Connecting to Postgres (attempt ${i + 1}/${retries})...`);
      await pgClient.connect();
      console.log('Connected to Postgres database.');
      
      await pgClient.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id VARCHAR(50) PRIMARY KEY,
          user_id VARCHAR(50) NOT NULL,
          product_id VARCHAR(50) NOT NULL,
          product_name VARCHAR(100) NOT NULL,
          quantity INT NOT NULL,
          total_amount DECIMAL(10, 2) NOT NULL,
          status VARCHAR(20) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db = pgClient;
      return;
    } catch (err) {
      console.error(`Postgres connection failed: ${err.message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.warn('Could not reach PostgreSQL. Falling back to local In-Memory Database.');
  db = new MemoryDb();
}

// EventBus Integration
const eventBus = new EventBus('order-service', 'order-service-group');

async function handlePaymentEvent(payload) {
  const { orderId, status, reason } = payload;
  console.log(`[OrderService] Processing billing outcome event. Status: ${status}`);
  
  await db.query(
    'UPDATE orders SET status = $1 WHERE id = $2',
    [status, orderId]
  );

  if (status === 'CONFIRMED') {
    await eventBus.publish('order.confirmed', { orderId, status: 'CONFIRMED' });
  } else {
    await eventBus.publish('order.failed', { orderId, status: 'FAILED', reason: reason || 'Payment failed' });
  }
}

async function connectEventBus() {
  await eventBus.connect();
  
  // Register topic subscriptions
  await eventBus.subscribe('payment.processed', async (payload) => {
    await handlePaymentEvent({ orderId: payload.orderId, status: 'CONFIRMED' });
  });

  await eventBus.subscribe('payment.failed', async (payload) => {
    await handlePaymentEvent({ orderId: payload.orderId, status: 'FAILED', reason: payload.reason });
  });

  await eventBus.startConsumer();
}

// HTTP Mock Callback Webhook endpoint (for local mock event broker)
app.post('/_mock_event', async (req, res) => {
  const { topic, data } = req.body;
  await eventBus.triggerMockEvent(topic, data);
  res.sendStatus(200);
});

// REST Endpoints
app.post('/orders', async (req, res) => {
  const { productId, quantity } = req.body;
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(400).json({ error: 'Missing x-user-id header' });
  if (!productId || !PRODUCTS[productId]) return res.status(400).json({ error: 'Invalid Product ID' });
  if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Quantity must be > 0' });

  const product = PRODUCTS[productId];
  const totalAmount = product.price * quantity;
  const orderId = crypto.randomUUID();

  try {
    await db.query(
      'INSERT INTO orders (id, user_id, product_id, product_name, quantity, total_amount, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [orderId, userId, productId, product.name, quantity, totalAmount, 'PENDING']
    );

    // Emit order.placed
    await eventBus.publish('order.placed', {
      orderId,
      userId,
      productId,
      productName: product.name,
      quantity,
      totalAmount
    });

    res.status(202).json({
      message: 'Order received. Processing payment and inventory.',
      orderId,
      status: 'PENDING',
      totalAmount
    });
  } catch (err) {
    console.error('Database write error:', err.message);
    res.status(500).json({ error: 'Database save failure' });
  }
});

app.get('/orders', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Query parameter userId is required' });

  try {
    const result = await db.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const formattedOrders = result.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      total_amount: row.total_amount,
      status: row.status,
      created_at: row.created_at,
      items: [{ productId: row.product_id, name: row.product_name, quantity: row.quantity }]
    }));
    res.json(formattedOrders);
  } catch (err) {
    console.error('Database read error:', err.message);
    res.status(500).json({ error: 'Database query failure' });
  }
});

// Start Server
app.listen(PORT, async () => {
  console.log(`Order Service running on port ${PORT}`);
  await connectDatabase();
  await connectEventBus();
});
