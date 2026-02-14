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

  // Serve generate page at /
  app.get('/', async (c) => {
    const fs = await import('fs');
    const path = await import('path');
    const htmlPath = path.join(process.cwd(), 'src/pages/generate.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return c.html(html);
  });

  // Serve admin UI static files
  app.use('/admin/*', serveStatic({ root: './admin/dist' }));
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.get('/admin/*', serveStatic({ root: './admin/dist', rewriteRequestPath: () => '/index.html' }));

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
