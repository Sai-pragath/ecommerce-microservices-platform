const { fork } = require('child_process');
const path = require('path');

const SERVICES = [
  { name: 'Gateway', dir: 'gateway', file: 'server.js', port: 3000, env: {} },
  { name: 'OrderService', dir: 'order-service', file: 'server.js', port: 3001, env: {} },
  { name: 'InventoryService', dir: 'inventory-service', file: 'server.js', port: 3002, env: {} },
  { name: 'PaymentService', dir: 'payment-service', file: 'server.js', port: 3003, env: {} },
  { name: 'NotificationService', dir: 'notification-service', file: 'server.js', port: 3004, env: {} }
];

const children = [];

console.log('====================================================');
console.log('   Starting Distributed E-Commerce Microservices    ');
console.log('   Mode: Local Mock (No Docker/Kafka/Postgres/Redis) ');
console.log('====================================================');

// Start all services
SERVICES.forEach(svc => {
  const filePath = path.join(__dirname, svc.dir, svc.file);
  const child = fork(filePath, [], {
    silent: true,
    env: {
      ...process.env,
      PORT: svc.port,
      ...svc.env
    }
  });

  children.push({ proc: child, name: svc.name });

  // Route stdout logs
  child.stdout.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      console.log(`[\x1b[36m${svc.name}\x1b[0m] ${line}`);
    });
  });

  // Route stderr logs
  child.stderr.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      console.error(`[\x1b[31m${svc.name} ERROR\x1b[0m] ${line}`);
    });
  });

  child.on('close', code => {
    console.log(`[System] ${svc.name} exited with code ${code}`);
  });
});

console.log('[System] All microservices started successfully.');
console.log('[System] Open your browser and navigate to: http://localhost:3000');
console.log('[System] Press Ctrl+C to terminate all services.');

// Handle clean exit
function shutdown() {
  console.log('\n[System] Terminating all microservices...');
  children.forEach(child => {
    child.proc.kill();
  });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
