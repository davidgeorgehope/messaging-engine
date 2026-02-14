module.exports = {
  apps: [
    {
      name: 'messaging-engine',
      script: 'npx',
      args: 'tsx watch src/index.ts',
      cwd: '/root/messaging-engine',
      watch: false, // tsx watch handles its own file watching
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: 'data/dev-error.log',
      out_file: 'data/dev-out.log',
      merge_logs: true,
      time: true, // prefix logs with timestamps
      kill_timeout: 5000, // 5s graceful shutdown (SIGTERM then SIGKILL)
    },
  ],
};
