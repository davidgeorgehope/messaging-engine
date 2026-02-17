// Public API: POST /api/generate and GET /api/voices
// Route definitions only — pipeline logic extracted to src/services/pipeline/

import { Hono } from 'hono';
import { getDatabase } from '../db/index.js';
import { voiceProfiles, messagingAssets } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/hash.js';
import { mkdirSync } from 'fs';
import { readFile, writeFile, readdir } from 'fs/promises';
import { ExtractRequestSchema, validateBody, validationError } from './validation.js';
import { join } from 'path';

// Re-export everything that external files depend on (backwards compatibility)
export { generateContent, runPublicGenerationJob, emitPipelineStep, updateJobProgress, generateAndScore, refinementLoop, storeVariant, finalizeJob } from '../services/pipeline/orchestrator.js';
export type { JobInputs, GenerateAndScoreResult } from '../services/pipeline/orchestrator.js';
export { type EvidenceBundle, type PractitionerQuote, classifyEvidenceLevel, runCommunityDeepResearch, runCompetitiveResearch } from '../services/pipeline/evidence.js';
export {
  ALL_ASSET_TYPES,
  ASSET_TYPE_TEMPERATURE,
  ASSET_TYPE_LABELS,
  PERSONA_ANGLES,
  loadTemplate,
  buildSystemPrompt,
  buildUserPrompt,
  buildPoVFirstPrompt,
  buildPainFirstPrompt,
  buildRefinementPrompt,
  buildResearchPromptFromInsights,
  generateBannedWords,
  bannedWordsCache,
  getBannedWordsForVoice,
} from '../services/pipeline/prompts.js';

const UPLOADS_DIR = join(process.cwd(), 'data', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const logger = createLogger('api:generate');

const app = new Hono();

// POST /api/upload — save file to disk, return file ID
app.post('/upload', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file uploaded. Send a single file as "file" field.' }, 400);
    }

    const fileId = generateId();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = join(UPLOADS_DIR, `${fileId}_${safeName}`);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await writeFile(filePath, buffer);

    logger.info('File uploaded', { fileId, name: file.name, size: buffer.length, path: filePath });

    return c.json({ fileId, name: file.name, size: buffer.length });
  } catch (error) {
    logger.error('File upload failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Upload failed', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// POST /api/extract — extract text from an uploaded file by ID
app.post('/extract', async (c) => {
  try {
    const parsed = await validateBody(c, ExtractRequestSchema);
    if (!parsed) return validationError(c);
    const { fileId, name } = parsed;

    const files = await readdir(UPLOADS_DIR);
    const match = files.find(f => f.startsWith(fileId));

    if (!match) {
      return c.json({ error: `File ${fileId} not found` }, 404);
    }

    const filePath = join(UPLOADS_DIR, match);
    const buffer = await readFile(filePath);
    const fileName = name || match.replace(`${fileId}_`, '');

    if (fileName.toLowerCase().endsWith('.pdf')) {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer } as any);
      const data = await parser.getText();

      logger.info('PDF extracted', { fileId, name: fileName, pages: data.pages?.length, textLength: data.text.length });

      return c.json({
        fileId,
        name: fileName,
        text: data.text,
        pages: data.pages?.length ?? 0,
      });
    } else {
      const text = buffer.toString('utf-8');
      logger.info('Text file read', { fileId, name: fileName, textLength: text.length });

      return c.json({
        fileId,
        name: fileName,
        text,
        pages: 0,
      });
    }
  } catch (error) {
    logger.error('Text extraction failed', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Extraction failed', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// GET /api/voices — return all active voice profiles
app.get('/voices', async (c) => {
  const db = getDatabase();
  const voices = await db.query.voiceProfiles.findMany({
    where: eq(voiceProfiles.isActive, true),
  });

  return c.json(voices.map(v => ({
    id: v.id,
    name: v.name,
    slug: v.slug,
    description: v.description,
    isDefault: v.isDefault,
  })));
});

// GET /api/asset-types — return available asset types
app.get('/asset-types', async (c) => {
  const { ALL_ASSET_TYPES, ASSET_TYPE_LABELS } = await import('../services/pipeline/prompts.js');
  return c.json(ALL_ASSET_TYPES.map(t => ({
    id: t,
    label: ASSET_TYPE_LABELS[t],
  })));
});

// GET /api/history — return past generations
app.get('/history', async (c) => {
  const db = getDatabase();
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const assets = await db.query.messagingAssets.findMany({
    orderBy: (assets, { desc }) => [desc(assets.createdAt)],
    limit,
    offset,
  });

  const generations = new Map<string, any>();
  for (const asset of assets) {
    const meta = JSON.parse(asset.metadata || '{}');
    const genId = meta.generationId || asset.jobId || asset.id;
    if (!generations.has(genId)) {
      generations.set(genId, {
        generationId: genId,
        createdAt: asset.createdAt,
        assets: [],
      });
    }
    generations.get(genId).assets.push({
      id: asset.id,
      assetType: asset.assetType,
      title: asset.title,
      content: asset.content,
      voiceName: meta.voiceName,
      scores: {
        slop: asset.slopScore,
        vendorSpeak: asset.vendorSpeakScore,
        specificity: asset.specificityScore,
        persona: asset.personaAvgScore,
        narrativeArc: asset.narrativeArcScore,
      },
      status: asset.status,
      createdAt: asset.createdAt,
    });
  }

  return c.json(Array.from(generations.values()));
});

export default app;
