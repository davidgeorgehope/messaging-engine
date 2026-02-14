// Messaging Generation Orchestrator
// 5-step pipeline: Research -> Generate -> Score -> Stress-test -> Store
//
// Adapted from o11y.tips generation/orchestrator.ts pattern but with
// fundamentally different steps: instead of content generation, this
// produces scored messaging assets with full traceability.

import { getDatabase } from '../../db/index.js';
import { generationJobs, discoveredPainPoints, messagingAssets, assetVariants, assetTraceability, competitiveResearch, productDocuments, voiceProfiles, messagingPriorities } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '../../utils/logger.js';
import { generateId } from '../../utils/hash.js';
import { config } from '../../config.js';
import { createDeepResearchInteraction, pollInteractionUntilComplete } from '../research/deep-research.js';
import { parseResearchOutput } from '../research/parser.js';
import { buildResearchPrompt } from '../research/prompts.js';
import { generateMessaging } from './messaging-generator.js';
import { scoreAllVariants } from '../quality/scorer.js';
import { deslopIfNeeded } from '../quality/slop-detector.js';
import { filterRelevantDocs } from './product-filter.js';
import type { GenerationContext, AssetType, ScoredVariant } from './types.js';

const logger = createLogger('generation:orchestrator');

const DEFAULT_ASSET_TYPES: AssetType[] = ['battlecard', 'talk_track', 'launch_messaging', 'social_hook'];

export async function createGenerationJob(painPointId: string, assetTypes?: AssetType[]): Promise<string> {
  const db = getDatabase();
  const painPoint = await db.query.discoveredPainPoints.findFirst({
    where: eq(discoveredPainPoints.id, painPointId),
  });
  if (!painPoint) throw new Error(`Pain point ${painPointId} not found`);

  const jobId = generateId();
  await db.insert(generationJobs).values({
    id: jobId,
    painPointId,
    priorityId: painPoint.priorityId,
    status: 'pending',
    currentStep: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Mark pain point as queued
  await db.update(discoveredPainPoints)
    .set({ status: 'queued', updatedAt: new Date().toISOString() })
    .where(eq(discoveredPainPoints.id, painPointId));

  logger.info('Generation job created', { jobId, painPointId });
  return jobId;
}

export async function runGenerationJob(jobId: string): Promise<void> {
  const db = getDatabase();

  const job = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, jobId),
  });
  if (!job) throw new Error(`Job ${jobId} not found`);

  try {
    // Update job status
    await updateJob(jobId, { status: 'research', currentStep: 'research', progress: 5, startedAt: new Date().toISOString() });

    // Load context (painPointId/priorityId are required for discovery-pipeline jobs)
    if (!job.painPointId || !job.priorityId) {
      throw new Error(`Job ${jobId} missing painPointId or priorityId — cannot run discovery pipeline`);
    }
    const context = await loadGenerationContext(job.painPointId, job.priorityId);

    // Step 1: Competitive Research (20%)
    logger.info('Step 1: Competitive Research', { jobId });
    await updateJob(jobId, { progress: 10 });

    const research = await runCompetitiveResearch(jobId, context);
    if (research) {
      context.competitiveResearch = research;
    }
    await updateJob(jobId, { progress: 30, competitiveResearch: JSON.stringify(research) });

    // Step 2: Messaging Generation (50%)
    logger.info('Step 2: Messaging Generation', { jobId });
    await updateJob(jobId, { status: 'generate', currentStep: 'generate', progress: 35 });

    const variants = await generateMessaging(context);
    await updateJob(jobId, { progress: 55 });

    // Step 3: Quality Scoring + Stress Testing (80%)
    logger.info('Step 3: Quality Scoring', { jobId });
    await updateJob(jobId, { status: 'score', currentStep: 'score', progress: 60 });

    let scoredVariants = await scoreAllVariants(variants, context);
    await updateJob(jobId, { progress: 80 });

    // Step 3b: Deslop failed variants
    if (config.generation.maxDeslopAttempts > 0) {
      scoredVariants = await deslopFailedVariants(scoredVariants, context, config.generation.maxDeslopAttempts);
    }

    // Step 4: Store Results (95%)
    logger.info('Step 4: Storing Results', { jobId });
    await updateJob(jobId, { status: 'store', currentStep: 'store', progress: 85 });

    await storeResults(jobId, context, scoredVariants);

    // Complete
    await updateJob(jobId, { status: 'completed', progress: 100, completedAt: new Date().toISOString() });

    // Update pain point status
    if (job.painPointId) {
      await db.update(discoveredPainPoints)
        .set({ status: 'completed', updatedAt: new Date().toISOString() })
        .where(eq(discoveredPainPoints.id, job.painPointId));
    }

    logger.info('Generation job completed', { jobId });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;

    logger.error('Generation job failed', { jobId, error: message });

    await updateJob(jobId, {
      status: 'failed',
      errorMessage: message,
      errorStack: stack,
      retryCount: (job.retryCount || 0) + 1,
    });

    // Reset pain point to pending for retry
    if (job.painPointId) {
      await db.update(discoveredPainPoints)
        .set({ status: 'pending', updatedAt: new Date().toISOString() })
        .where(eq(discoveredPainPoints.id, job.painPointId));
    }

    throw error;
  }
}

async function loadGenerationContext(painPointId: string, priorityId: string): Promise<GenerationContext> {
  const db = getDatabase();

  const [painPoint, priority, docs, voices] = await Promise.all([
    db.query.discoveredPainPoints.findFirst({ where: eq(discoveredPainPoints.id, painPointId) }),
    db.query.messagingPriorities.findFirst({ where: eq(messagingPriorities.id, priorityId) }),
    db.query.productDocuments.findMany({ where: eq(productDocuments.isActive, true) }),
    db.query.voiceProfiles.findMany({ where: eq(voiceProfiles.isActive, true) }),
  ]);

  if (!painPoint) throw new Error(`Pain point ${painPointId} not found`);
  if (!priority) throw new Error(`Priority ${priorityId} not found`);

  const painAnalysis = JSON.parse(painPoint.painAnalysis || '{}');
  const priorityKeywords = JSON.parse(priority.keywords || '[]');

  // Enrich docs with description and tags, then filter by relevance
  const enrichedDocs = docs.map(d => ({
    id: d.id,
    name: d.name,
    content: d.content,
    description: d.description,
    tags: JSON.parse(d.tags || '[]') as string[],
  }));

  const filteredDocs = filterRelevantDocs(enrichedDocs, {
    painPointTitle: painPoint.title,
    painPointKeywords: painAnalysis.keywords ?? [],
    priorityKeywords,
  });

  return {
    painPoint: {
      id: painPoint.id,
      title: painPoint.title,
      content: painPoint.content,
      practitionerQuotes: JSON.parse(painPoint.practitionerQuotes || '[]'),
      painAnalysis,
    },
    priority: {
      id: priority.id,
      name: priority.name,
      keywords: priorityKeywords,
    },
    productDocs: filteredDocs.map(d => ({ id: d.id, name: d.name, content: d.content })),
    voiceProfiles: voices.map(v => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      voiceGuide: v.voiceGuide || '',
      scoringThresholds: JSON.parse(v.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}'),
    })),
    assetTypes: DEFAULT_ASSET_TYPES,
  };
}

async function runCompetitiveResearch(jobId: string, context: GenerationContext) {
  try {
    const prompt = buildResearchPrompt(
      context.painPoint.title,
      context.painPoint.content,
      context.painPoint.practitionerQuotes,
      context.productDocs.map(d => d.content),
      context.priority.name,
    );

    // Create Deep Research interaction
    const interactionId = await createDeepResearchInteraction(prompt);

    const db = getDatabase();
    await db.update(generationJobs)
      .set({ geminiInteractionId: interactionId, geminiStatus: 'running', updatedAt: new Date().toISOString() })
      .where(eq(generationJobs.id, jobId));

    // Poll until complete
    const result = await pollInteractionUntilComplete(interactionId, (status) => {
      // Update gemini status in background
      db.update(generationJobs)
        .set({ geminiStatus: status, updatedAt: new Date().toISOString() })
        .where(eq(generationJobs.id, jobId))
        .catch(() => {});
    });

    // Parse research output
    const { structured, markdown } = await parseResearchOutput(result.text, context.painPoint.title);

    // Store research
    const researchId = generateId();
    await db.insert(competitiveResearch).values({
      id: researchId,
      jobId,
      painPointId: context.painPoint.id,
      rawReport: result.text,
      structuredAnalysis: JSON.stringify(structured),
      groundingSources: JSON.stringify(result.sources),
      geminiInteractionId: interactionId,
      status: 'completed',
      createdAt: new Date().toISOString(),
    });

    return {
      researchId,
      rawReport: result.text,
      structuredAnalysis: structured as unknown as Record<string, unknown>,
      sources: result.sources.map(s => ({ title: s.title, url: s.url })),
    };
  } catch (error) {
    logger.warn('Competitive research failed, continuing without it', { error });
    return undefined;
  }
}

async function storeResults(jobId: string, context: GenerationContext, scoredVariants: any[]) {
  const db = getDatabase();

  // Group variants by asset type
  const byAssetType = new Map<string, any[]>();
  for (const variant of scoredVariants) {
    const key = variant.assetType;
    if (!byAssetType.has(key)) byAssetType.set(key, []);
    byAssetType.get(key)!.push(variant);
  }

  for (const [assetType, variants] of byAssetType) {
    // Create parent messaging_assets record
    const assetId = generateId();

    // Calculate average scores across variants
    const avgSlop = variants.reduce((sum: number, v: any) => sum + v.slopScore, 0) / variants.length;
    const avgVendor = variants.reduce((sum: number, v: any) => sum + v.vendorSpeakScore, 0) / variants.length;
    const avgSpecificity = variants.reduce((sum: number, v: any) => sum + v.specificityScore, 0) / variants.length;
    const avgPersona = variants.reduce((sum: number, v: any) => sum + v.personaAvgScore, 0) / variants.length;
    const anyPasses = variants.some((v: any) => v.passesGates);

    await db.insert(messagingAssets).values({
      id: assetId,
      priorityId: context.priority.id,
      jobId,
      painPointId: context.painPoint.id,
      assetType,
      title: `${assetType.replace(/_/g, ' ')} — ${context.painPoint.title.substring(0, 100)}`,
      content: variants[0]?.content || '',
      metadata: JSON.stringify({ variantCount: variants.length }),
      slopScore: avgSlop,
      vendorSpeakScore: avgVendor,
      specificityScore: avgSpecificity,
      personaAvgScore: avgPersona,
      status: anyPasses ? 'review' : 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Store each variant
    for (const variant of variants) {
      await db.insert(assetVariants).values({
        id: generateId(),
        assetId,
        voiceProfileId: variant.voiceProfileId,
        variantNumber: variant.variantNumber,
        content: variant.content,
        slopScore: variant.slopScore,
        vendorSpeakScore: variant.vendorSpeakScore,
        authenticityScore: variant.authenticityScore,
        specificityScore: variant.specificityScore,
        personaAvgScore: variant.personaAvgScore,
        passesGates: variant.passesGates,
        isSelected: false,
        createdAt: new Date().toISOString(),
      });
    }

    // Store traceability — one row per product doc (or one row if no docs)
    const researchId = context.competitiveResearch?.researchId ?? null;
    const productDocIds = context.productDocs.map(d => d.id);

    if (productDocIds.length === 0) {
      await db.insert(assetTraceability).values({
        id: generateId(),
        assetId,
        painPointId: context.painPoint.id,
        researchId,
        productDocId: null,
        practitionerQuotes: JSON.stringify(context.painPoint.practitionerQuotes),
        createdAt: new Date().toISOString(),
      });
    } else {
      for (const productDocId of productDocIds) {
        await db.insert(assetTraceability).values({
          id: generateId(),
          assetId,
          painPointId: context.painPoint.id,
          researchId,
          productDocId,
          practitionerQuotes: JSON.stringify(context.painPoint.practitionerQuotes),
          createdAt: new Date().toISOString(),
        });
      }
    }
  }
}

async function deslopFailedVariants(
  scoredVariants: ScoredVariant[],
  context: GenerationContext,
  maxAttempts: number,
): Promise<ScoredVariant[]> {
  const results: ScoredVariant[] = [...scoredVariants];

  for (const variant of scoredVariants) {
    // Skip variants that already pass gates
    if (variant.passesGates) continue;

    // Find the voice profile thresholds to check if slop is the failing dimension
    const voiceProfile = context.voiceProfiles.find(v => v.id === variant.voiceProfileId);
    const thresholds = voiceProfile?.scoringThresholds || {
      slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6,
    };

    // Only deslop if slop score exceeds threshold
    if (variant.slopScore <= thresholds.slopMax) continue;

    logger.info('Deslopping failed variant', {
      voiceProfileId: variant.voiceProfileId,
      assetType: variant.assetType,
      slopScore: variant.slopScore,
      threshold: thresholds.slopMax,
    });

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { content: deslopped, wasDeslopped } = await deslopIfNeeded(variant.content, thresholds.slopMax);
      if (!wasDeslopped) break;

      // Re-score the deslopped content
      const deslopVariant = {
        voiceProfileId: variant.voiceProfileId,
        variantNumber: variant.variantNumber + 100 + attempt,
        content: deslopped,
        assetType: variant.assetType,
      };

      const [rescored] = await scoreAllVariants([deslopVariant], context);
      results.push(rescored);

      logger.info('Deslopped variant scored', {
        variantNumber: rescored.variantNumber,
        slopScore: rescored.slopScore,
        passesGates: rescored.passesGates,
      });

      // Stop if it passes now
      if (rescored.passesGates) break;
    }
  }

  return results;
}

async function updateJob(jobId: string, updates: Record<string, any>) {
  const db = getDatabase();
  await db.update(generationJobs)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(generationJobs.id, jobId));
}
