const express = require('express');
const EventBus = require('./event-bus');

const PORT = process.env.PORT || 3004;
const app = express();
app.use(express.json());

// EventBus Integration
const eventBus = new EventBus('notification-service', 'notification-service-group');

async function sendEmailNotification(topic, payload) {
  const { orderId, userId, amount, reason } = payload;
  console.log(`[Notification] Processing notifications for topic: ${topic}`);

  if (topic === 'order.placed') {
    console.log(`[Email] MOCK SEND: 'Order Placed' email dispatch successful to user ${userId} for order ID: ${orderId}.`);
    await eventBus.publish('notification.sent', {
      orderId,
      userId,
      type: 'ORDER_PLACED_EMAIL',
      message: `Your order for items has been received and is pending payment.`
    });
  } else if (topic === 'payment.processed') {
    console.log(`[Email] MOCK SEND: 'Order Confirmed & Receipt' email dispatch successful for order ID: ${orderId}. Total Charged: $${amount}.`);
    await eventBus.publish('notification.sent', {
      orderId,
      type: 'RECEIPT_EMAIL',
      message: `Payment successful! Your order has been confirmed and shipped.`
    });
  } else if (topic === 'payment.failed') {
    console.log(`[Email] MOCK SEND: 'Payment Failure Warning' alert sent to user ${userId} for order ID: ${orderId}. Reason: ${reason}`);
    await eventBus.publish('notification.sent', {
      orderId,
      userId,
      type: 'PAYMENT_FAILED_ALERT',
      message: `Payment declined for your order. Reason: ${reason}`
    });
  }
}

async function connectEventBus() {
  await eventBus.connect();

  await eventBus.subscribe('order.placed', async (payload) => {
    await sendEmailNotification('order.placed', payload);
  });

  await eventBus.subscribe('payment.processed', async (payload) => {
    await sendEmailNotification('payment.processed', payload);
  });

  await eventBus.subscribe('payment.failed', async (payload) => {
    await sendEmailNotification('payment.failed', payload);
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
  console.log(`Notification Service running on port ${PORT}`);
  await connectEventBus();
});
