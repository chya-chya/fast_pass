module.exports = {
  apps: [
    {
      name: 'fast_pass',
      script: 'dist/src/main.js',
      instances: 'max', // Use all available CPU cores
      exec_mode: 'cluster', // Enable load balancing
      autorestart: true,
      watch: false,
      max_memory_restart: '250M', // Restart if memory exceeds 250MB per process
      env: {
        NODE_ENV: 'production',
      },
      // Pass CLI args to script so NestJS + Tracing works
      node_args: '-r ./dist/src/tracing.js', 
    },
    {
      name: 'pm2-prometheus-exporter',
      script: './node_modules/pm2-prometheus-exporter/exporter.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: {
        METRICS_PORT: 9209,
        PM2_PROMETHEUS_EXPORTER_PORT: 9209,
      },
    },
  ],
};
