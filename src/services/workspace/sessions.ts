import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import {
  sessions,
  sessionVersions,
  discoveredPainPoints,
  generationJobs,
  voiceProfiles,
  productDocuments,
  messagingAssets,
  assetVariants,
} from '../../db/schema.js';
import { generateId, hashContent } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { runPublicGenerationJob, ASSET_TYPE_LABELS } from '../../api/generate.js';
import { PUBLIC_GENERATION_PRIORITY_ID } from '../../db/seed.js';
import { generateWithGemini } from '../ai/clients.js';
import type { ExtractedInsights } from '../product/insights.js';
import { createInitialVersions } from './versions.js';
import type { AssetType } from '../generation/types.js';

const logger = createLogger('workspace:sessions');

export interface CreateSessionInput {
  painPointId?: string;
  manualPainPoint?: { title: string; description: string; quotes?: string[] };
  voiceProfileId?: string;
  voiceProfileIds?: string[];
  assetTypes: string[];
  productDocIds?: string[];
  productContext?: string;
  focusInstructions?: string;
  pipeline?: string;
}

export async function createSession(userId: string, data: CreateSessionInput) {
  const db = getDatabase();
  const now = new Date().toISOString();

  let painPointId = data.painPointId || null;

  // If manual pain point provided, create a discovered_pain_points row
  if (data.manualPainPoint && !painPointId) {
    const ppId = generateId();
    const contentStr = data.manualPainPoint.title + '\n' + data.manualPainPoint.description;
    await db.insert(discoveredPainPoints).values({
      id: ppId,
      priorityId: PUBLIC_GENERATION_PRIORITY_ID,
      sourceType: 'manual',
      sourceUrl: 'manual://workspace',
      sourceId: generateId(),
      title: data.manualPainPoint.title,
      content: data.manualPainPoint.description,
      author: 'manual',
      authorLevel: 'unknown',
      metadata: JSON.stringify({}),
      painScore: 1.0,
      painAnalysis: JSON.stringify({ source: 'manual' }),
      practitionerQuotes: JSON.stringify(data.manualPainPoint.quotes || []),
      status: 'approved',
      contentHash: hashContent(contentStr),
      discoveredAt: now,
      createdAt: now,
      updatedAt: now,
    });
    painPointId = ppId;
  }

  const sessionId = generateId();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    name: 'New Session',
    painPointId,
    voiceProfileId: data.voiceProfileIds?.length ? null : data.voiceProfileId || null,
    assetTypes: JSON.stringify(data.assetTypes),
    status: 'pending',
    manualPainPoint: data.manualPainPoint ? JSON.stringify(data.manualPainPoint) : null,
    productDocIds: data.productDocIds ? JSON.stringify(data.productDocIds) : null,
    productContext: data.productContext || null,
    focusInstructions: data.focusInstructions || null,
    pipeline: data.pipeline || 'standard',
    metadata: JSON.stringify(data.voiceProfileIds?.length ? { voiceProfileIds: data.voiceProfileIds } : {}),
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  });

  // Auto-name from pain point/manual input (pipeline will refine with insights later)
  autoNameSession(sessionId, data, painPointId).catch(err => {
    logger.warn('Auto-naming failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
  });

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  return session!;
}

export async function startSessionGeneration(sessionId: string) {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error(`Session ${sessionId} not found`);

  // Load voice profile(s) — single ID in column, or array in metadata
  let voiceProfileIds: string[] = [];
  const sessionMeta = JSON.parse(session.metadata || '{}');
  if (sessionMeta.voiceProfileIds?.length) {
    voiceProfileIds = sessionMeta.voiceProfileIds;
  } else if (session.voiceProfileId) {
    voiceProfileIds = [session.voiceProfileId];
  } else {
    const allVoices = await db.query.voiceProfiles.findMany({
      where: eq(voiceProfiles.isActive, true),
      columns: { id: true },
    });
    voiceProfileIds = allVoices.map(v => v.id);
  }

  // Build product docs string
  let productDocs = '';
  const docIds = session.productDocIds ? JSON.parse(session.productDocIds) : [];
  if (docIds.length > 0) {
    const docs = await Promise.all(
      docIds.map((id: string) => db.query.productDocuments.findFirst({ where: eq(productDocuments.id, id) }))
    );
    productDocs = docs.filter(Boolean).map((d: any) => `## ${d.name}\n${d.content}`).join('\n\n');
  }
  if (session.productContext) {
    productDocs = productDocs ? `${productDocs}\n\n## Additional Context\n${session.productContext}` : session.productContext;
  }

  // Prepend pain point context
  let painContext = '';
  if (session.painPointId) {
    const painPoint = await db.query.discoveredPainPoints.findFirst({
      where: eq(discoveredPainPoints.id, session.painPointId),
    });
    if (painPoint) {
      painContext = `## Pain Point\n### ${painPoint.title}\n${painPoint.content}`;
      const quotes = JSON.parse(painPoint.practitionerQuotes || '[]');
      if (quotes.length > 0) {
        painContext += `\n### Practitioner Quotes\n${quotes.map((q: string) => `> ${q}`).join('\n')}`;
      }
    }
  }

  if (painContext) {
    productDocs = `${painContext}\n\n${productDocs}`;
  }

  if (!productDocs.trim()) {
    productDocs = 'No product documentation provided. Generate based on available context.';
  }

  const assetTypes = JSON.parse(session.assetTypes);
  const pipeline = session.pipeline || 'standard';

  // Build prompt from pain point or focus instructions
  let prompt = 'Generate messaging assets.';
  if (session.painPointId) {
    const painPoint = await db.query.discoveredPainPoints.findFirst({
      where: eq(discoveredPainPoints.id, session.painPointId),
    });
    if (painPoint) {
      prompt = `Generate messaging addressing this practitioner pain point: ${painPoint.title}`;
    }
  } else if (session.focusInstructions) {
    prompt = session.focusInstructions;
  }

  // Create generation job
  const jobId = generateId();
  const now = new Date().toISOString();

  await db.insert(generationJobs).values({
    id: jobId,
    status: 'pending',
    currentStep: 'Queued',
    progress: 0,
    productContext: JSON.stringify({
      productDocs,
      prompt,
      voiceProfileIds,
      assetTypes,
      model: 'gemini-3-pro-preview',
      pipeline,
    }),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // Update session
  await db.update(sessions)
    .set({ status: 'generating', jobId, updatedAt: now })
    .where(eq(sessions.id, sessionId))
    .run();

  // Fire-and-forget the generation pipeline
  runPublicGenerationJob(jobId)
    .then(async () => {
      await db.update(sessions)
        .set({ status: 'completed', updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .run();
      // Create initial session versions from job results
      await createInitialVersions(sessionId, jobId).catch(err => {
        logger.warn('Failed to create initial versions', { sessionId, jobId, error: err instanceof Error ? err.message : String(err) });
      });
      logger.info('Session generation completed', { sessionId, jobId });
    })
    .catch(async (error) => {
      logger.error('Session generation failed', {
        sessionId, jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      await db.update(sessions)
        .set({ status: 'failed', updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .run();
      // Also update the job if it hasn't been updated
      await db.update(generationJobs)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(generationJobs.id, jobId))
        .run();
    });

  return { session: { ...session, status: 'generating', jobId }, jobId };
}

export async function getSessionWithResults(sessionId: string, userId?: string, role?: string) {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) return null;
  if (userId && userId !== 'admin-env' && role !== 'admin' && session.userId !== userId) return null;

  const response: any = { session };

  if (session.jobId) {
    const job = await db.query.generationJobs.findFirst({
      where: eq(generationJobs.id, session.jobId),
    });
    response.job = job ? {
      id: job.id,
      status: job.status,
      currentStep: job.currentStep,
      progress: job.progress,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    } : null;

    if (job && job.status === 'completed') {
      const assets = await db.query.messagingAssets.findMany({
        where: eq(messagingAssets.jobId, session.jobId!),
      });

      const assetIds = assets.map(a => a.id);
      const variants = assetIds.length > 0
        ? await db.query.assetVariants.findMany({ where: inArray(assetVariants.assetId, assetIds) })
        : [];

      const byType = new Map<string, any>();
      for (const asset of assets) {
        const meta = JSON.parse(asset.metadata || '{}');
        if (!byType.has(asset.assetType)) {
          byType.set(asset.assetType, {
            assetType: asset.assetType,
            label: ASSET_TYPE_LABELS[asset.assetType as AssetType] || asset.assetType,
            variants: [],
          });
        }

        const variant = variants.find(v => v.assetId === asset.id);
        byType.get(asset.assetType).variants.push({
          id: variant?.id || asset.id,
          assetId: asset.id,
          voiceProfileId: meta.voiceId,
          voiceName: meta.voiceName,
          voiceSlug: meta.voiceSlug,
          content: asset.content,
          scores: {
            slop: asset.slopScore,
            vendorSpeak: asset.vendorSpeakScore,
            authenticity: variant?.authenticityScore ?? null,
            specificity: asset.specificityScore,
            persona: asset.personaAvgScore,
          },
          passesGates: variant?.passesGates ?? false,
        });
      }

      response.results = Array.from(byType.values());
    }
  }

  // Load session versions
  const versions = await db.query.sessionVersions.findMany({
    where: eq(sessionVersions.sessionId, sessionId),
    orderBy: [desc(sessionVersions.versionNumber)],
  });
  if (versions.length > 0) {
    // Group by asset type
    const versionsByType: Record<string, any[]> = {};
    for (const v of versions) {
      if (!versionsByType[v.assetType]) versionsByType[v.assetType] = [];
      versionsByType[v.assetType].push(v);
    }
    response.versions = versionsByType;
  }

  // Load pain point details if present
  if (session.painPointId) {
    const painPoint = await db.query.discoveredPainPoints.findFirst({
      where: eq(discoveredPainPoints.id, session.painPointId),
    });
    response.painPoint = painPoint ? {
      id: painPoint.id,
      title: painPoint.title,
      content: painPoint.content,
      painScore: painPoint.painScore,
    } : null;
  }

  return response;
}

export async function getSessionStatus(sessionId: string) {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) return null;

  if (!session.jobId) {
    return { status: session.status, progress: 0, currentStep: null };
  }

  const job = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, session.jobId),
  });

  // Sync session status from job
  if (job) {
    if (job.status === 'completed' && session.status === 'generating') {
      await db.update(sessions)
        .set({ status: 'completed', updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .run();
    } else if (job.status === 'failed' && session.status === 'generating') {
      await db.update(sessions)
        .set({ status: 'failed', updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .run();
    }
  }

  return {
    status: job?.status === 'completed' ? 'completed' : job?.status === 'failed' ? 'failed' : session.status,
    progress: job?.progress ?? 0,
    currentStep: job?.currentStep ?? null,
    errorMessage: job?.errorMessage ?? null,
  };
}

export async function listUserSessions(
  userId: string,
  opts: { limit?: number; offset?: number; includeArchived?: boolean } = {}
) {
  const db = getDatabase();
  const { limit = 50, offset = 0, includeArchived = false } = opts;

  const conditions = [eq(sessions.userId, userId)];
  if (!includeArchived) {
    conditions.push(eq(sessions.isArchived, false));
  }

  const results = await db.query.sessions.findMany({
    where: and(...conditions),
    orderBy: [desc(sessions.createdAt)],
    limit,
    offset,
  });

  return results;
}

export async function deleteSession(sessionId: string, userId: string, role?: string) {
  const db = getDatabase();

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');
  if (userId !== 'admin-env' && role !== 'admin' && session.userId !== userId) throw new Error('Not authorized');

  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  logger.info('Session deleted', { sessionId, userId });
}

export async function updateSession(
  sessionId: string,
  userId: string,
  updates: { name?: string; isArchived?: boolean },
  role?: string,
) {
  const db = getDatabase();

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');
  if (userId !== 'admin-env' && role !== 'admin' && session.userId !== userId) throw new Error('Not authorized');

  const setFields: Record<string, any> = { updatedAt: new Date().toISOString() };
  if (updates.name !== undefined) setFields.name = updates.name;
  if (updates.isArchived !== undefined) setFields.isArchived = updates.isArchived;

  await db.update(sessions).set(setFields).where(eq(sessions.id, sessionId)).run();

  return db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
}

async function autoNameSession(sessionId: string, data: CreateSessionInput, painPointId: string | null) {
  const db = getDatabase();

  // Quick deterministic placeholder from structured input — no AI call.
  // The real name gets set by nameSessionFromInsights() once the pipeline
  // has extracted product insights (summary, domain, category).
  let name = '';
  if (painPointId) {
    const pp = await db.query.discoveredPainPoints.findFirst({
      where: eq(discoveredPainPoints.id, painPointId),
    });
    if (pp) name = pp.title.substring(0, 60);
  } else if (data.manualPainPoint) {
    name = data.manualPainPoint.title.substring(0, 60);
  } else if (data.focusInstructions) {
    name = data.focusInstructions.substring(0, 60);
  }

  if (name) {
    await db.update(sessions)
      .set({ name, updatedAt: new Date().toISOString() })
      .where(eq(sessions.id, sessionId))
      .run();
    logger.info('Session placeholder-named', { sessionId, name });
  }
  // If no structured input available, keep "New Session" — pipeline will rename.
}

/**
 * Rename a session using extracted product insights.
 * Called by the generation pipeline after extractInsights() completes.
 * Uses the insights summary to generate a concise session name via Gemini Flash.
 */
export async function nameSessionFromInsights(jobId: string, insights: ExtractedInsights, assetTypes: AssetType[]) {
  const db = getDatabase();

  // Find the session linked to this job
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.jobId, jobId),
  });
  if (!session) return; // No session (e.g. standalone job) — skip

  const assetTypeLabels = assetTypes.map(t => ASSET_TYPE_LABELS[t] || t).join(', ');
  const topic = insights.summary || `${insights.domain} ${insights.category}`.trim();

  if (!topic || topic === 'unknown unknown') return; // No useful signal

  try {
    const prompt = `Generate a concise 3-6 word name for a messaging session.\nTopic: ${topic}\nAsset types: ${assetTypeLabels}\nExamples: 'Log Pipeline Cost Battlecard', 'K8s Alert Fatigue Launch Pack', 'Workflow Automation Messaging Suite'\nReturn ONLY the name, no quotes.`;

    const result = await generateWithGemini(prompt, {
      temperature: 0.3,
      maxTokens: 50,
    });

    const name = result.text.trim().replace(/^["']|["']$/g, '');
    if (name && name.length >= 3 && name.length < 100) {
      await db.update(sessions)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, session.id))
        .run();
      logger.info('Session named from insights', { sessionId: session.id, jobId, name });
    }
  } catch (error) {
    // Non-fatal — keep whatever placeholder name exists
    logger.warn('Failed to name session from insights', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
