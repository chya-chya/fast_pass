const Redis = require('ioredis');

// Get config from args or defaults
const host = process.argv[2] || process.env.REDIS_HOST;
const port = process.argv[3] || process.env.REDIS_PORT || 6379;
const useTls = process.argv[4] === 'true';

if (!host) {
  console.error("Usage: node debug_redis.js <host> <port> <useTls:true|false>");
  process.exit(1);
}

console.log(`Testing connection to ${host}:${port} (TLS: ${useTls})...`);

const redis = new Redis.Cluster([{ host, port }], {
  redisOptions: {
    tls: useTls ? { checkServerIdentity: () => undefined } : undefined,
    dnsLookup: (address, callback) => callback(null, address),
  },
  retryStrategy: () => false, // Don't retry, just fail
});

redis.on('connect', () => {
  console.log('✅ Connection Successful!');
  redis.quit();
});

redis.on('error', (err) => {
  console.error('❌ Connection Failed:', err.message);
  redis.quit();
});
