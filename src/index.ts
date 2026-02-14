import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from './api/index.js';
import { initializeDatabase } from './db/index.js';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

async function main() {
  logger.info('Starting Messaging Engine');

  // Initialize database (seeds voice profiles if needed)
  await initializeDatabase();

  // Create API
  const app = createApi();

  // Static assets from Vite build
  app.use('/assets/*', serveStatic({ root: './admin/dist' }));

  // SPA: serve index.html for all frontend routes (React Router handles routing)
  const serveSpa = async (c: any) => {
    const fs = await import('fs');
    try {
      const html = fs.readFileSync('./admin/dist/index.html', 'utf-8');
      return c.html(html);
    } catch {
      return c.text('UI not built. Run: cd admin && npm run build', 500);
    }
  };
  for (const route of ['/', '/admin', '/admin/*', '/workspace', '/workspace/*', '/login', '/signup']) {
    app.get(route, serveSpa);
  }

  // Start server
  const server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  });

  logger.info(`Server running on http://${config.server.host}:${config.server.port}`);

  // Graceful shutdown
  process.on('SIGINT', () => { process.exit(0); });
  process.on('SIGTERM', () => { process.exit(0); });
}

main().catch((error) => {
  logger.error('Failed to start server', error);
  process.exit(1);
});
