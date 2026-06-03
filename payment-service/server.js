const express = require('express');
const crypto = require('crypto');
const EventBus = require('./event-bus');

const PORT = process.env.PORT || 3003;
const app = express();
app.use(express.json());

// EventBus Integration
const eventBus = new EventBus('payment-service', 'payment-service-group');

async function processPayment(payload) {
  const { orderId, userId, productId, quantity, totalAmount } = payload;
  console.log(`[Payment] Processing charge of $${totalAmount} for order ${orderId} by user ${userId}...`);

  // Simulate payment gateway latency (1.5 seconds)
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Failure trigger: username is 'fail' or random 15% chance
  const shouldFail = userId.toLowerCase() === 'fail' || Math.random() < 0.15;

  if (shouldFail) {
    console.log(`[Payment] Payment FAILED for order ID: ${orderId}`);
    await eventBus.publish('payment.failed', {
      orderId,
      productId,
      quantity,
      userId,
      reason: 'Card declined: Insufficient funds'
    });
  } else {
    console.log(`[Payment] Payment SUCCESS for order ID: ${orderId}`);
    await eventBus.publish('payment.processed', {
      orderId,
      paymentId: crypto.randomUUID(),
      status: 'SUCCESS',
      amount: totalAmount
    });
  }
}

async function connectEventBus() {
  await eventBus.connect();

  await eventBus.subscribe('order.placed', async (payload) => {
    // Process asynchronously to avoid blocking the event loop
    processPayment(payload).catch(err => console.error('Error during payment processing:', err.message));
  });

  await eventBus.startConsumer();
}

// HTTP Mock Callback Webhook endpoint (for local mock event broker)
app.post('/_mock_event', async (req, res) => {
  const { topic, data } = req.body;
  await eventBus.triggerMockEvent(topic, data);
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  res.json({ status: 'UP' });
});

app.listen(PORT, async () => {
  console.log(`Payment Service running on port ${PORT}`);
  await connectEventBus();
});
