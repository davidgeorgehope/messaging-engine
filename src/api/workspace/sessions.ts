import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createSession,
  startSessionGeneration,
  getSessionWithResults,
  getSessionStatus,
  listUserSessions,
  updateSession,
} from '../../services/workspace/sessions.js';
import {
  getVersions,
  createEditVersion,
  activateVersion,
} from '../../services/workspace/versions.js';
import {
  runDeslopAction,
  runRegenerateAction,
  runVoiceChangeAction,
  runAdversarialLoopAction,
  runCompetitiveDeepDiveAction,
  runCommunityCheckAction,
} from '../../services/workspace/actions.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('api:workspace:sessions');

type Variables = { user: { id: string | null; username: string; displayName: string; role: string } };
const app = new Hono<{ Variables: Variables }>();

// GET /sessions — list user sessions
app.get('/', async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: 'User ID required' }, 400);

  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const archived = c.req.query('archived') === 'true';

  const sessions = await listUserSessions(user.id, { limit, offset, includeArchived: archived });
  return c.json({ data: sessions });
});

// POST /sessions — create + start session
app.post('/', async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: 'User ID required' }, 400);

  try {
    const body = await c.req.json();
    const { painPointId, manualPainPoint, voiceProfileId, voiceProfileIds, assetTypes, productDocIds, productContext, focusInstructions, pipeline } = body;

    if (!assetTypes || !Array.isArray(assetTypes) || assetTypes.length === 0) {
      return c.json({ error: 'assetTypes array is required' }, 400);
    }

    const session = await createSession(user.id, {
      painPointId,
      manualPainPoint,
      voiceProfileId,
      voiceProfileIds,
      assetTypes,
      productDocIds,
      productContext,
      focusInstructions,
      pipeline,
    });

    // Start generation immediately
    const result = await startSessionGeneration(session.id);

    return c.json({ session: result.session, jobId: result.jobId }, 201);
  } catch (error) {
    logger.error('Failed to create session', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Failed to create session' }, 500);
  }
});

// GET /sessions/:id — get session with results
app.get('/:id', async (c) => {
  const sessionId = c.req.param('id');
  const user = c.get('user');

  try {
    const result = await getSessionWithResults(sessionId, user?.id ?? undefined, user?.role);
    if (!result) return c.json({ error: 'Session not found' }, 404);
    return c.json(result);
  } catch (error) {
    logger.error('Failed to get session', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Failed to get session' }, 500);
  }
});

// PUT /sessions/:id — update session
app.put('/:id', async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: 'User ID required' }, 400);

  const sessionId = c.req.param('id');
  const body = await c.req.json();

  try {
    const session = await updateSession(sessionId, user.id, body, user.role);
    return c.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update session';
    const status = message === 'Not authorized' ? 403 : message === 'Session not found' ? 404 : 500;
    return c.json({ error: message }, status);
  }
});

// GET /sessions/:id/status — poll generation progress
app.get('/:id/status', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const status = await getSessionStatus(sessionId);
    if (!status) return c.json({ error: 'Session not found' }, 404);
    return c.json(status);
  } catch (error) {
    logger.error('Failed to get session status', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Failed to get session status' }, 500);
  }
});

// ===== Version endpoints =====

// GET /sessions/:id/versions?assetType=X — list versions for asset type
app.get('/:id/versions', async (c) => {
  const sessionId = c.req.param('id');
  const assetType = c.req.query('assetType');
  if (!assetType) return c.json({ error: 'assetType query param required' }, 400);

  try {
    const versions = await getVersions(sessionId, assetType);
    return c.json({ data: versions });
  } catch (error) {
    return c.json({ error: 'Failed to get versions' }, 500);
  }
});

// POST /sessions/:id/versions — create version from edit
app.post('/:id/versions', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const { assetType, content } = await c.req.json();
    if (!assetType || !content) {
      return c.json({ error: 'assetType and content are required' }, 400);
    }

    const version = await createEditVersion(sessionId, assetType, content);
    return c.json({ version }, 201);
  } catch (error) {
    logger.error('Failed to create version', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Failed to create version' }, 500);
  }
});

// PUT /sessions/:id/versions/:vid/activate — set as active version
app.put('/:id/versions/:vid/activate', async (c) => {
  const sessionId = c.req.param('id');
  const versionId = c.req.param('vid');

  try {
    const version = await activateVersion(sessionId, versionId);
    return c.json({ version });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to activate version';
    return c.json({ error: message }, message === 'Version not found' ? 404 : 500);
  }
});

// ===== Action endpoints =====

// POST /sessions/:id/actions/deslop
app.post('/:id/actions/deslop', async (c) => {
  const sessionId = c.req.param('id');
  try {
    const { assetType } = await c.req.json();
    if (!assetType) return c.json({ error: 'assetType is required' }, 400);
    const version = await runDeslopAction(sessionId, assetType);
    return c.json({ version });
  } catch (error) {
    logger.error('Deslop action failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Deslop failed' }, 500);
  }
});

// POST /sessions/:id/actions/regenerate
app.post('/:id/actions/regenerate', async (c) => {
  const sessionId = c.req.param('id');
  try {
    const { assetType } = await c.req.json();
    if (!assetType) return c.json({ error: 'assetType is required' }, 400);
    const version = await runRegenerateAction(sessionId, assetType);
    return c.json({ version });
  } catch (error) {
    logger.error('Regenerate action failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Regenerate failed' }, 500);
  }
});

// POST /sessions/:id/actions/change-voice
app.post('/:id/actions/change-voice', async (c) => {
  const sessionId = c.req.param('id');
  try {
    const { assetType, voiceProfileId } = await c.req.json();
    if (!assetType || !voiceProfileId) return c.json({ error: 'assetType and voiceProfileId are required' }, 400);
    const version = await runVoiceChangeAction(sessionId, assetType, voiceProfileId);
    return c.json({ version });
  } catch (error) {
    logger.error('Voice change action failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Voice change failed' }, 500);
  }
});

// POST /sessions/:id/actions/adversarial
app.post('/:id/actions/adversarial', async (c) => {
  const sessionId = c.req.param('id');
  try {
    const { assetType } = await c.req.json();
    if (!assetType) return c.json({ error: 'assetType is required' }, 400);
    const version = await runAdversarialLoopAction(sessionId, assetType);
    return c.json({ version });
  } catch (error) {
    logger.error('Adversarial action failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Adversarial loop failed' }, 500);
  }
});

// POST /sessions/:id/actions/competitive-dive
app.post('/:id/actions/competitive-dive', async (c) => {
  const sessionId = c.req.param('id');
  try {
    const { assetType } = await c.req.json();
    if (!assetType) return c.json({ error: 'assetType is required' }, 400);
    const version = await runCompetitiveDeepDiveAction(sessionId, assetType);
    return c.json({ version });
  } catch (error) {
    logger.error('Competitive dive action failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Competitive dive failed' }, 500);
  }
});

// POST /sessions/:id/actions/community-check
app.post('/:id/actions/community-check', async (c) => {
  const sessionId = c.req.param('id');
  try {
    const { assetType } = await c.req.json();
    if (!assetType) return c.json({ error: 'assetType is required' }, 400);
    const version = await runCommunityCheckAction(sessionId, assetType);
    return c.json({ version });
  } catch (error) {
    logger.error('Community check action failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: error instanceof Error ? error.message : 'Community check failed' }, 500);
  }
});

export default app;
