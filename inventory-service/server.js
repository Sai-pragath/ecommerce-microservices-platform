const express = require('express');
const { createClient } = require('redis');
const EventBus = require('./event-bus');

const PORT = process.env.PORT || 3002;

const DEFAULT_PRODUCTS = {
  'prod-1': { id: 'prod-1', name: 'Cyberpunk Jacket', price: 129.99, stock: 10, description: 'Genuine leather with neon trim' },
  'prod-2': { id: 'prod-2', name: 'Holographic Glasses', price: 49.50, stock: 5, description: 'Augmented reality display visor' },
  'prod-3': { id: 'prod-3', name: 'Neural Link Interface', price: 899.00, stock: 2, description: 'Direct brain-to-net chip' }
};

const app = express();
app.use(express.json());

// In-Memory Redis Mock Fallback Class
class MemoryRedis {
  constructor() {
    this.store = {};
  }
  async connect() {
    console.log('[Redis] Using local In-Memory product stock store fallback.');
    await this.refill();
  }
  async exists(key) {
    return !!this.store[key];
  }
  async hSet(key, fieldOrHash, value) {
    if (typeof fieldOrHash === 'string' && value !== undefined) {
      this.store[key] = this.store[key] || {};
      this.store[key][fieldOrHash] = value;
    } else {
      this.store[key] = { ...this.store[key], ...fieldOrHash };
    }
  }
  async hGet(key, field) {
    return this.store[key] ? this.store[key][field] : null;
  }
  async hGetAll(key) {
    return this.store[key] || {};
  }
  async keys(pattern) {
    return Object.keys(this.store);
  }
  async refill() {
    for (const [id, prod] of Object.entries(DEFAULT_PRODUCTS)) {
      this.store[`product:${id}`] = {
        id: prod.id,
        name: prod.name,
        price: prod.price.toString(),
        stock: prod.stock.toString(),
        description: prod.description
      };
    }
  }
}

// Client Selector
let redis;
const redisClient = createClient({
  url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`
});

async function connectRedis(retries = 5, delay = 2000) {
  if (!process.env.REDIS_HOST) {
    redis = new MemoryRedis();
    await redis.connect();
    return;
  }

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Connecting to Redis (attempt ${i + 1}/${retries})...`);
      await redisClient.connect();
      console.log('Connected to Redis.');
      
      // Initialize default values in Redis
      for (const [id, prod] of Object.entries(DEFAULT_PRODUCTS)) {
        const exists = await redisClient.exists(`product:${id}`);
        if (!exists) {
          await redisClient.hSet(`product:${id}`, {
            id: prod.id,
            name: prod.name,
            price: prod.price.toString(),
            stock: prod.stock.toString(),
            description: prod.description
          });
        }
      }
      redis = redisClient;
      return;
    } catch (err) {
      console.error(`Redis connection failed: ${err.message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.warn('Could not reach Redis. Falling back to local In-Memory Redis Mock.');
  redis = new MemoryRedis();
  await redis.connect();
}

// EventBus Integration
const eventBus = new EventBus('inventory-service', 'inventory-service-group');

async function handleOrderPlaced(orderId, productId, quantity) {
  const key = `product:${productId}`;
  try {
    const stockStr = await redis.hGet(key, 'stock');
    if (!stockStr) {
      await eventBus.publish('inventory.failed', { orderId, reason: 'Product not found' });
      return;
    }

    const currentStock = parseInt(stockStr, 10);
    if (currentStock < quantity) {
      console.log(`Insufficient stock for ${productId}. Requested: ${quantity}, Available: ${currentStock}`);
      await eventBus.publish('inventory.failed', { orderId, reason: 'Insufficient Stock' });
      return;
    }

    const newStock = currentStock - quantity;
    await redis.hSet(key, 'stock', newStock.toString());
    console.log(`Reserved ${quantity} units of ${productId}. Stock remaining: ${newStock}`);
    await eventBus.publish('inventory.reserved', { orderId, productId, quantity, status: 'RESERVED' });
  } catch (err) {
    console.error('Error reserving stock:', err.message);
    await eventBus.publish('inventory.failed', { orderId, reason: 'Internal inventory error' });
  }
}

async function rollbackStock(orderId, productId, quantity) {
  try {
    const key = `product:${productId}`;
    const stockStr = await redis.hGet(key, 'stock');
    if (stockStr) {
      const currentStock = parseInt(stockStr, 10);
      const newStock = currentStock + quantity;
      await redis.hSet(key, 'stock', newStock.toString());
      console.log(`Rollback order ${orderId}: Restored ${quantity} items to ${productId}. New stock: ${newStock}`);
    }
  } catch (err) {
    console.error('Error rolling back stock:', err.message);
  }
}

async function connectEventBus() {
  await eventBus.connect();

  await eventBus.subscribe('order.placed', async (payload) => {
    await handleOrderPlaced(payload.orderId, payload.productId, payload.quantity);
  });

  await eventBus.subscribe('payment.failed', async (payload) => {
    if (payload.productId && payload.quantity) {
      await rollbackStock(payload.orderId, payload.productId, payload.quantity);
    }
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
app.get('/inventory', async (req, res) => {
  try {
    const keys = await redis.keys('product:*');
    const items = [];
    for (const key of keys) {
      const data = await redis.hGetAll(key);
      items.push({
        id: data.id,
        name: data.name,
        price: parseFloat(data.price),
        stock: parseInt(data.stock, 10),
        description: data.description
      });
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    res.json(items);
  } catch (err) {
    console.error('Error reading inventory:', err.message);
    res.status(500).json({ error: 'Database read failure' });
  }
});

app.post('/inventory/refill', async (req, res) => {
  try {
    if (typeof redis.refill === 'function') {
      await redis.refill();
    } else {
      for (const [id, prod] of Object.entries(DEFAULT_PRODUCTS)) {
        await redis.hSet(`product:${id}`, {
          id: prod.id,
          name: prod.name,
          price: prod.price.toString(),
          stock: prod.stock.toString(),
          description: prod.description
        });
      }
    }
    console.log('Stock refilled to defaults.');
    res.json({ message: 'Inventory refilled successfully' });
  } catch (err) {
    console.error('Error refilling stock:', err.message);
    res.status(500).json({ error: 'Database write failure' });
  }
});

// Start Server
app.listen(PORT, async () => {
  console.log(`Inventory Service running on port ${PORT}`);
  await connectRedis();
  await connectEventBus();
});
