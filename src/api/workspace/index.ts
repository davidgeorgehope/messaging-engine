import { Hono } from 'hono';
import { workspaceAuth } from '../middleware/auth.js';
import sessionsRoutes from './sessions.js';
import chatRoutes from './chat.js';

const workspace = new Hono();
workspace.use('*', workspaceAuth);
workspace.route('/sessions', sessionsRoutes);

// Chat routes are nested under sessions path
workspace.route('/sessions', chatRoutes);

export default workspace;
