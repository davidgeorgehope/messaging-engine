import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { logger as honoLogger } from 'hono/logger';
import { adminAuth, generateToken } from './middleware/auth.js';
import { config } from '../config.js';
import { getDatabase } from '../db/index.js';
import { messagingPriorities, discoveredPainPoints, generationJobs, messagingAssets, voiceProfiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { authenticateUser, createUser } from '../services/auth/users.js';

// Admin route imports
import prioritiesRoutes from './admin/priorities.js';
import discoveryRoutes from './admin/discovery.js';
import jobsRoutes from './admin/jobs.js';
import messagingRoutes from './admin/messaging.js';
import documentsRoutes from './admin/documents.js';
import voicesRoutes from './admin/voices.js';
import personasRoutes from './admin/personas.js';
import gapsRoutes from './admin/gaps.js';
import settingsRoutes from './admin/settings.js';

// Public route imports
import generateRoutes from './generate.js';

// Workspace route imports
import workspaceRoutes from './workspace/index.js';

export function createApi() {
  const app = new Hono();

  app.use('*', cors());
  app.use('*', honoLogger());
  // Allow up to 50MB request bodies (needed for PDF uploads)
  app.use('*', bodyLimit({ maxSize: 50 * 1024 * 1024 }));

  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // Public API routes (no auth)
  app.route('/api', generateRoutes);

  // Login — try users table first, then fall back to env var admin
  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json();
    const { username, password } = body;

    // First: check users table
    const user = await authenticateUser(username, password);
    if (user) {
      const token = await generateToken(user.username, user.role, user.id);
      return c.json({
        token,
        user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
        expiresIn: config.admin.jwtExpiresIn,
      });
    }

    // Fallback: env var admin credentials
    if (username === config.admin.username && password === config.admin.password) {
      const token = await generateToken(username);
      return c.json({ token, expiresIn: config.admin.jwtExpiresIn });
    }

    return c.json({ error: 'Invalid credentials' }, 401);
  });

  // Signup
  app.post('/api/auth/signup', async (c) => {
    try {
      const body = await c.req.json();
      const { username, email, password, displayName } = body;

      if (!username || !email || !password || !displayName) {
        return c.json({ error: 'username, email, password, and displayName are required' }, 400);
      }

      const user = await createUser({ username, email, password, displayName });
      const token = await generateToken(user.username, user.role, user.id);

      return c.json({
        token,
        user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
        expiresIn: config.admin.jwtExpiresIn,
      }, 201);
    } catch (error: any) {
      if (error.message?.includes('UNIQUE constraint')) {
        return c.json({ error: 'Username or email already taken' }, 409);
      }
      return c.json({ error: error.message || 'Signup failed' }, 500);
    }
  });

  // Admin API routes (protected)
  const admin = new Hono();
  admin.use('*', adminAuth);
  admin.route('/priorities', prioritiesRoutes);
  admin.route('/discovery', discoveryRoutes);
  admin.route('/jobs', jobsRoutes);
  admin.route('/messaging', messagingRoutes);
  admin.route('/documents', documentsRoutes);
  admin.route('/voices', voicesRoutes);
  admin.route('/personas', personasRoutes);
  admin.route('/gaps', gapsRoutes);
  admin.route('/settings', settingsRoutes);

  // Dashboard stats
  admin.get('/stats', async (c) => {
    const db = getDatabase();
    const [priorities, painPoints, pendingPainPoints, jobs, runningJobs, assets, reviewAssets, voices] = await Promise.all([
      db.query.messagingPriorities.findMany({ columns: { id: true } }),
      db.query.discoveredPainPoints.findMany({ columns: { id: true } }),
      db.query.discoveredPainPoints.findMany({ where: eq(discoveredPainPoints.status, 'pending'), columns: { id: true } }),
      db.query.generationJobs.findMany({ columns: { id: true } }),
      db.query.generationJobs.findMany({ where: (jobs, { notInArray }) => notInArray(jobs.status, ['pending', 'completed', 'failed']), columns: { id: true } }),
      db.query.messagingAssets.findMany({ columns: { id: true } }),
      db.query.messagingAssets.findMany({ where: eq(messagingAssets.status, 'review'), columns: { id: true } }),
      db.query.voiceProfiles.findMany({ where: eq(voiceProfiles.isActive, true), columns: { id: true } }),
    ]);

    return c.json({
      priorities: { total: priorities.length },
      discovery: { total: painPoints.length, pending: pendingPainPoints.length },
      jobs: { total: jobs.length, running: runningJobs.length },
      messaging: { total: assets.length, review: reviewAssets.length },
      voices: { active: voices.length },
    });
  });

  app.route('/api/admin', admin);

  // Workspace API routes (user auth)
  app.route('/api/workspace', workspaceRoutes);

  return app;
}
