import type { VoiceProfile, ScoringThresholds, PipelineStep, PipelineStepData } from '../../types/index.js';
// Pipeline orchestration: job helpers, generate+score, refinement, variant storage, dispatch
// Extracted from src/api/generate.ts

import { getDatabase } from '../../db/index.js';
import { voiceProfiles, messagingAssets, assetVariants, assetTraceability, generationJobs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../../utils/logger.js';
import { generateId } from '../../utils/hash.js';
import { deslop } from '../../services/quality/slop-detector.js';
import { scoreContent, checkQualityGates as checkGates, totalQualityScore, type ScoreResults, type ScorerHealth } from '../../services/quality/score-content.js';
import type { PersonaScoringContext } from '../../services/quality/persona-critic.js';
import { validateGrounding } from '../../services/quality/grounding-validator.js';
import { PUBLIC_GENERATION_PRIORITY_ID } from '../../db/seed.js';
import type { AssetType } from '../../services/generation/types.js';
import type { GenerateOptions, AIResponse } from '../../services/ai/types.js';
import { generateWithClaude, generateWithGemini } from '../../services/ai/clients.js';
import { getModelForTask } from '../../config.js';
import { withLLMContext } from '../../services/ai/call-context.js';
import { ASSET_TYPE_LABELS, ASSET_TYPE_TEMPERATURE, buildRefinementPrompt } from './prompts.js';
import type { EvidenceBundle } from './evidence.js';
import { sessions } from '../../db/schema.js';

const logger = createLogger('pipeline:orchestrator');

// ---------------------------------------------------------------------------
// Job Inputs
// ---------------------------------------------------------------------------

export interface JobInputs {
  productDocs: string;
  existingMessaging?: string;
  prompt?: string;
  voiceProfileIds: string[];
  assetTypes: AssetType[];
  model: string;
  pipeline: string;
  selectedVoices: VoiceProfile[];
}

export async function loadJobInputs(jobId: string): Promise<JobInputs> {
  const db = getDatabase();
  const job = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, jobId),
  });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const inputs = JSON.parse(job.productContext || '{}');

  const allVoices = await db.query.voiceProfiles.findMany({
    where: eq(voiceProfiles.isActive, true),
  });
  const selectedVoices = allVoices.filter(v => inputs.voiceProfileIds.includes(v.id));

  return {
    productDocs: inputs.productDocs,
    existingMessaging: inputs.existingMessaging,
    prompt: inputs.prompt,
    voiceProfileIds: inputs.voiceProfileIds,
    assetTypes: inputs.assetTypes,
    model: inputs.model,
    pipeline: inputs.pipeline || 'standard',
    selectedVoices,
  };
}

// ---------------------------------------------------------------------------
// Pipeline Step Events
// ---------------------------------------------------------------------------

export function emitPipelineStep(jobId: string, step: string, status: 'running' | 'complete', data?: PipelineStepData) {
  const db = getDatabase();
  const job = db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).get();
  const steps = JSON.parse((job as { pipelineSteps?: string } | undefined)?.pipelineSteps || '[]');

  if (status === 'running') {
    steps.push({ step, status, startedAt: new Date().toISOString(), ...(data?.model && { model: data.model }) });
  } else {
    const existing = steps.findLast((s: PipelineStep) => s.step === step);
    if (existing) {
      existing.status = 'complete';
      existing.completedAt = new Date().toISOString();
      if (data?.model) existing.model = data.model;
      if (data?.draft) existing.draft = data.draft.substring(0, 2000);
      if (data?.scores) existing.scores = data.scores;
      if (data?.scorerHealth) existing.scorerHealth = data.scorerHealth;
    }
  }

  db.update(generationJobs)
    .set({ pipelineSteps: JSON.stringify(steps), updatedAt: new Date().toISOString() })
    .where(eq(generationJobs.id, jobId))
    .run();
}

export function updateJobProgress(jobId: string, fields: Record<string, any>) {
  const db = getDatabase();
  db.update(generationJobs)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(generationJobs.id, jobId))
    .run();
}

// ---------------------------------------------------------------------------
// generateContent — AI dispatch. Default: Gemini Pro for all generation.
// ---------------------------------------------------------------------------

export async function generateContent(
  prompt: string,
  options: GenerateOptions,
  model?: string,
): Promise<AIResponse> {
  if (model && model.includes('claude')) {
    return generateWithClaude(prompt, { ...options, model });
  }
  return generateWithGemini(prompt, {
    ...options,
    model: getModelForTask('pro'),
  });
}

// ---------------------------------------------------------------------------
// Generate and Score
// ---------------------------------------------------------------------------

export interface GenerateAndScoreResult {
  content: string;
  scores: ScoreResults;
  passesGates: boolean;
  needsManualReview?: boolean;
}

export async function generateAndScore(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  scoringContext: string,
  thresholds: ScoringThresholds,
  assetType?: AssetType,
  personaContext?: PersonaScoringContext,
): Promise<GenerateAndScoreResult> {
  const temperature = assetType ? ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7 : 0.7;
  const response = await generateContent(userPrompt, {
    systemPrompt,
    temperature,
  }, model);

  const scores = await scoreContent(response.text, [scoringContext], personaContext);
  const passesGates = checkGates(scores, thresholds);

  return { content: response.text, scores, passesGates };
}

// ---------------------------------------------------------------------------
// Refinement Loop
// ---------------------------------------------------------------------------

export async function refinementLoop(
  content: string,
  scoringContext: string,
  thresholds: ScoringThresholds,
  voice: VoiceProfile,
  assetType: AssetType,
  systemPrompt: string,
  model: string,
  maxIterations: number = 3,
  productName?: string,
  personaContext?: PersonaScoringContext,
): Promise<GenerateAndScoreResult> {
  let scores = await scoreContent(content, [scoringContext], personaContext);
  let wasDeslopped = false;

  if (scores.scorerHealth.failed.length >= 2) {
    logger.warn(`Skipping refinement — ${scores.scorerHealth.failed.length}/${scores.scorerHealth.total} scorers failed`, {
      failed: scores.scorerHealth.failed,
      assetType,
      voice: voice.name,
    });
    return { content, scores, passesGates: checkGates(scores, thresholds), needsManualReview: true };
  }

  for (let i = 0; i < maxIterations; i++) {
    if (checkGates(scores, thresholds)) break;

    if (scores.slopScore > thresholds.slopMax) {
      try {
        content = await deslop(content, scores.slopAnalysis);
        wasDeslopped = true;
      } catch (deslopErr) {
        logger.warn('Deslop failed, continuing with original', {
          error: deslopErr instanceof Error ? deslopErr.message : String(deslopErr),
        });
      }
    }

    const refinementPrompt = buildRefinementPrompt(content, scores, thresholds, voice, assetType, wasDeslopped, productName);
    try {
      const refined = await generateContent(refinementPrompt, {
        systemPrompt,
        temperature: 0.5,
      }, model);

      const newScores = await scoreContent(refined.text, [scoringContext], personaContext);

      if (totalQualityScore(newScores) <= totalQualityScore(scores)) {
        logger.info('Refinement plateau reached', { iteration: i, assetType, voice: voice.name });
        break;
      }

      content = refined.text;
      scores = newScores;
    } catch (refineErr) {
      logger.warn('Refinement generation failed, keeping current version', {
        error: refineErr instanceof Error ? refineErr.message : String(refineErr),
      });
      break;
    }
  }

  return { content, scores, passesGates: checkGates(scores, thresholds) };
}

// ---------------------------------------------------------------------------
// Store Variant
// ---------------------------------------------------------------------------

export async function storeVariant(
  jobId: string,
  assetType: AssetType,
  voice: VoiceProfile,
  content: string,
  scores: ScoreResults,
  passesGates: boolean,
  prompt?: string,
  evidence?: EvidenceBundle,
  generationPrompts?: { systemPrompt: string; userPrompt: string },
) {
  const db = getDatabase();
  const assetId = generateId();
  const variantId = generateId();

  let finalContent = content;
  let fabricationStripped = false;
  if (evidence) {
    try {
      const validation = await validateGrounding(content, evidence.evidenceLevel);
      if (validation.fabricationStripped && validation.strippedContent) {
        finalContent = validation.strippedContent;
        fabricationStripped = true;
        logger.info('Fabrication stripped from generated content', {
          jobId, assetType, voice: voice.name,
          patternsFound: validation.fabricationCount,
        });
      }
    } catch (err) {
      logger.warn('Grounding validation failed, keeping original content', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const metadata: Record<string, any> = {
    generationId: jobId,
    voiceId: voice.id,
    voiceName: voice.name,
    voiceSlug: voice.slug,
  };
  if (fabricationStripped) metadata.fabricationStripped = true;
  if (evidence) metadata.sourceCounts = evidence.sourceCounts;

  await db.insert(messagingAssets).values({
    id: assetId,
    priorityId: PUBLIC_GENERATION_PRIORITY_ID,
    jobId,
    assetType,
    title: `${ASSET_TYPE_LABELS[assetType]} — ${(prompt || 'Product docs generation').substring(0, 100)}`,
    content: finalContent,
    metadata: JSON.stringify(metadata),
    slopScore: scores.slopScore,
    vendorSpeakScore: scores.vendorSpeakScore,
    specificityScore: scores.specificityScore,
    personaAvgScore: scores.personaAvgScore,
    narrativeArcScore: scores.narrativeArcScore,
    evidenceLevel: evidence?.evidenceLevel ?? null,
    status: passesGates ? 'review' : 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await db.insert(assetVariants).values({
    id: variantId,
    assetId,
    voiceProfileId: voice.id,
    variantNumber: 1,
    content: finalContent,
    slopScore: scores.slopScore,
    vendorSpeakScore: scores.vendorSpeakScore,
    authenticityScore: scores.authenticityScore,
    specificityScore: scores.specificityScore,
    personaAvgScore: scores.personaAvgScore,
    narrativeArcScore: scores.narrativeArcScore,
    passesGates,
    isSelected: false,
    createdAt: new Date().toISOString(),
  });

  await db.insert(assetTraceability).values({
    id: generateId(),
    assetId,
    practitionerQuotes: JSON.stringify(evidence?.practitionerQuotes ?? []),
    generationPrompt: generationPrompts ? JSON.stringify({
      system: generationPrompts.systemPrompt.substring(0, 10000),
      user: generationPrompts.userPrompt.substring(0, 20000),
      timestamp: new Date().toISOString(),
    }) : null,
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Job Finalization
// ---------------------------------------------------------------------------

export async function finalizeJob(jobId: string, researchAvailable: boolean, researchLength: number): Promise<void> {
  const db = getDatabase();
  const job = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, jobId),
  });
  const updatedContext = JSON.parse(job?.productContext || '{}');
  updatedContext._researchAvailable = researchAvailable;
  updatedContext._researchLength = researchLength;

  updateJobProgress(jobId, {
    status: 'completed',
    currentStep: 'Complete',
    progress: 100,
    productContext: JSON.stringify(updatedContext),
    completedAt: new Date().toISOString(),
  });

  logger.info('Generation job completed', { jobId, pipeline: updatedContext.pipeline || 'standard' });
}

// ---------------------------------------------------------------------------
// Pipeline Dispatch
// ---------------------------------------------------------------------------

import { runStraightThroughPipeline } from './pipelines/straight-through.js';
import { runStandardPipeline } from './pipelines/standard.js';
import { runOutsideInPipeline } from './pipelines/outside-in.js';
import { runAdversarialPipeline } from './pipelines/adversarial.js';
import { runMultiPerspectivePipeline } from './pipelines/multi-perspective.js';

export const PIPELINE_RUNNERS: Record<string, (jobId: string, inputs: JobInputs) => Promise<void>> = {
  'straight-through': runStraightThroughPipeline,
  standard: runStandardPipeline,
  'outside-in': runOutsideInPipeline,
  adversarial: runAdversarialPipeline,
  'multi-perspective': runMultiPerspectivePipeline,
};

export async function runPublicGenerationJob(jobId: string): Promise<void> {
  const inputs = await loadJobInputs(jobId);
  const pipeline = inputs.pipeline || 'standard';
  const runner = PIPELINE_RUNNERS[pipeline] || PIPELINE_RUNNERS.standard;

  // Look up session for this job so LLM calls can be linked to the session
  let sessionId: string | undefined;
  try {
    const db = getDatabase();
    const session = await db.query.sessions.findFirst({ where: eq(sessions.jobId, jobId) });
    sessionId = session?.id;
  } catch { /* best effort */ }

  logger.info('Starting pipeline', { jobId, pipeline, sessionId });
  await withLLMContext({ purpose: `pipeline:${pipeline}`, jobId, sessionId }, async () => {
    await runner(jobId, inputs);
  });
}
