const { Kafka } = require('kafkajs');

const useMock = !process.env.KAFKA_BROKERS;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

class EventBus {
  constructor(clientId, groupId) {
    this.clientId = clientId;
    this.groupId = groupId;
    this.useMock = useMock;
    this.callbacks = {};

    if (!useMock) {
      this.kafka = new Kafka({
        clientId,
        brokers: process.env.KAFKA_BROKERS.split(',')
      });
      this.producer = this.kafka.producer();
      this.consumer = this.kafka.consumer({ groupId });
    }
  }

  async connect() {
    if (this.useMock) {
      console.log(`[EventBus] ${this.clientId} initialized in local Webhook Mock mode.`);
      return;
    }

    try {
      await this.producer.connect();
      await this.consumer.connect();
      console.log(`[EventBus] ${this.clientId} connected successfully to Redpanda/Kafka.`);
    } catch (err) {
      console.warn(`[EventBus] Kafka connection failed: ${err.message}. Falling back to local Webhook Mock.`);
      this.useMock = true;
    }
  }

  async subscribe(topic, callback) {
    this.callbacks[topic] = callback;
    if (!this.useMock) {
      try {
        await this.consumer.subscribe({ topic, fromBeginning: false });
      } catch (err) {
        console.error(`[EventBus] Subscribe error for topic ${topic}:`, err.message);
      }
    }
  }

  async startConsumer() {
    if (this.useMock) return;
    try {
      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const payload = JSON.parse(message.value.toString());
          if (this.callbacks[topic]) {
            await this.callbacks[topic](payload);
          }
        }
      });
    } catch (err) {
      console.error(`[EventBus] Consumer run error:`, err.message);
    }
  }

  async publish(topic, data) {
    if (this.useMock) {
      console.log(`[EventBus] Local publish to [${topic}]:`, data);
      try {
        // Forward event to Gateway mock broker endpoint
        const response = await fetch(`${GATEWAY_URL}/api/telemetry/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, data })
        });
        if (!response.ok) {
          console.error(`[EventBus] Gateway rejected mock publish for ${topic}`);
        }
      } catch (err) {
        console.error(`[EventBus] Gateway mock publish unreachable:`, err.message);
      }
      return;
    }

    try {
      await this.producer.send({
        topic,
        messages: [{ value: JSON.stringify(data) }]
      });
    } catch (err) {
      console.error(`[EventBus] Kafka publish failed for ${topic}:`, err.message);
    }
  }

  async triggerMockEvent(topic, data) {
    if (this.callbacks[topic]) {
      await this.callbacks[topic](data);
    } else {
      console.warn(`[EventBus] No registered callback for topic: ${topic}`);
    }
  }
}

module.exports = EventBus;
