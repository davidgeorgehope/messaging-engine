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

  // Serve admin UI static files (assets from build output)
  app.use('/assets/*', serveStatic({ root: './admin/dist' }));

  // Admin SPA routes
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.get('/admin/*', async (c) => {
    const fs = await import('fs');
    try {
      const html = fs.readFileSync('./admin/dist/index.html', 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Admin UI not built. Run: cd admin && npm run build', 500);
    }
  });

  // Workspace SPA routes
  app.get('/workspace', (c) => c.redirect('/workspace/'));
  app.get('/workspace/*', async (c) => {
    const fs = await import('fs');
    try {
      const html = fs.readFileSync('./admin/dist/index.html', 'utf-8');
      return c.html(html);
    } catch {
      return c.text('UI not built. Run: cd admin && npm run build', 500);
    }
  });

  // Login/signup SPA routes
  app.get('/login', async (c) => {
    const fs = await import('fs');
    try {
      const html = fs.readFileSync('./admin/dist/index.html', 'utf-8');
      return c.html(html);
    } catch {
      return c.text('UI not built. Run: cd admin && npm run build', 500);
    }
  });
  app.get('/signup', async (c) => {
    const fs = await import('fs');
    try {
      const html = fs.readFileSync('./admin/dist/index.html', 'utf-8');
      return c.html(html);
    } catch {
      return c.text('UI not built. Run: cd admin && npm run build', 500);
    }
  });

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
