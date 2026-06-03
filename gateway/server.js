const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Kafka } = require('kafkajs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ecommerce_secret_jwt_key_12345';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3001';
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002';

// Middleware to verify JWT
function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
}

// Authentication Routes
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }
  const token = jwt.sign({ userId: username, role: 'user' }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, username });
});

app.get('/api/auth/profile', authenticateJWT, (req, res) => {
  res.json({ userId: req.user.userId, role: req.user.role });
});

// Proxy routes for Order Service
app.post('/api/orders', authenticateJWT, async (req, res) => {
  try {
    const response = await fetch(`${ORDER_SERVICE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': req.user.userId
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying POST /orders:', error.message);
    res.status(502).json({ error: 'Order Service is currently offline' });
  }
});

app.get('/api/orders', authenticateJWT, async (req, res) => {
  try {
    const response = await fetch(`${ORDER_SERVICE_URL}/orders?userId=${req.user.userId}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying GET /orders:', error.message);
    res.status(502).json({ error: 'Order Service is currently offline' });
  }
});

// Proxy routes for Inventory Service
app.get('/api/inventory', async (req, res) => {
  try {
    const response = await fetch(`${INVENTORY_SERVICE_URL}/inventory`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying GET /inventory:', error.message);
    res.status(502).json({ error: 'Inventory Service is currently offline' });
  }
});

app.post('/api/inventory/refill', async (req, res) => {
  try {
    const response = await fetch(`${INVENTORY_SERVICE_URL}/inventory/refill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying POST /inventory/refill:', error.message);
    res.status(502).json({ error: 'Inventory Service is currently offline' });
  }
});

// --- Mock Broker Implementation ---
const SUBSCRIBERS = {
  'order.placed': [
    `${process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002'}/_mock_event`,
    `${process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003'}/_mock_event`,
    `${process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004'}/_mock_event`
  ],
  'payment.processed': [
    `${process.env.ORDER_SERVICE_URL || 'http://localhost:3001'}/_mock_event`,
    `${process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004'}/_mock_event`
  ],
  'payment.failed': [
    `${process.env.ORDER_SERVICE_URL || 'http://localhost:3001'}/_mock_event`,
    `${process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002'}/_mock_event`,
    `${process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3004'}/_mock_event`
  ],
  'inventory.reserved': [],
  'inventory.failed': [],
  'notification.sent': [],
  'order.confirmed': [],
  'order.failed': []
};

// Route for services to publish events when running in local mock mode
app.post('/api/telemetry/publish', async (req, res) => {
  const { topic, data } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });

  console.log(`[MockBroker] Event received [${topic}]:`, data);

  // 1. Broadcast to UI dashboard WebSockets
  io.emit('telemetry-event', {
    topic,
    timestamp: new Date().toISOString(),
    payload: data
  });

  // 2. Dispatch to other mock event webhook URLs
  const urls = SUBSCRIBERS[topic] || [];
  for (const url of urls) {
    // Run fetch in background to mimic async messaging
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, data })
    }).catch(err => {
      console.warn(`[MockBroker] Failed to deliver event [${topic}] to subscriber ${url}: ${err.message}`);
    });
  }

  res.sendStatus(200);
});

// Socket.io connection logging
io.on('connection', (socket) => {
  console.log(`WebSocket client connected: ${socket.id}`);
  socket.emit('system-info', { status: 'Connected', timestamp: new Date().toISOString() });
  socket.on('disconnect', () => {
    console.log(`WebSocket client disconnected: ${socket.id}`);
  });
});

// Kafka Integration
const isMock = !process.env.KAFKA_BROKERS;
let consumer;

async function connectKafka(retries = 15, delay = 5000) {
  if (isMock) {
    console.log('[Kafka] KAFKA_BROKERS not set. Running Gateway with local Mock Broker routing.');
    return;
  }

  const kafka = new Kafka({
    clientId: 'gateway-service',
    brokers: process.env.KAFKA_BROKERS.split(',')
  });

  consumer = kafka.consumer({ groupId: 'gateway-telemetry-group' });

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Connecting to Redpanda/Kafka (attempt ${i + 1}/${retries})...`);
      await consumer.connect();
      console.log('Connected to Redpanda/Kafka successfully.');
      
      const topics = Object.keys(SUBSCRIBERS);
      for (const topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: false });
        console.log(`Subscribed to topic: ${topic}`);
      }

      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const payload = JSON.parse(message.value.toString());
          console.log(`Broadcasting event [${topic}]:`, payload);
          io.emit('telemetry-event', {
            topic,
            timestamp: new Date().toISOString(),
            payload
          });
        }
      });
      return;
    } catch (err) {
      console.error(`Failed to connect to Redpanda: ${err.message}. Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  console.error('Could not connect to Redpanda. Telemetry broadcasts will be disabled.');
}

// Start Server
server.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
  connectKafka();
});
