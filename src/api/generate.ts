// Public API: POST /api/generate and GET /api/voices
// No auth required — this is the primary "dump docs, get messaging" experience

import { Hono } from 'hono';
import { getDatabase } from '../db/index.js';
import { voiceProfiles, messagingAssets, assetVariants, assetTraceability, generationJobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/hash.js';
import { generateWithClaude, generateWithGemini, generateWithGeminiGroundedSearch } from '../services/ai/clients.js';
import { config } from '../config.js';
import { createDeepResearchInteraction, pollInteractionUntilComplete } from '../services/research/deep-research.js';
import { PUBLIC_GENERATION_PRIORITY_ID } from '../db/seed.js';
import { analyzeSlop, deslop } from '../services/quality/slop-detector.js';
import { analyzeVendorSpeak } from '../services/quality/vendor-speak.js';
import { analyzeSpecificity } from '../services/quality/specificity.js';
import { runPersonaCritics } from '../services/quality/persona-critic.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AssetType } from '../services/generation/types.js';

const UPLOADS_DIR = join(process.cwd(), 'data', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const logger = createLogger('api:generate');

const TEMPLATE_DIR = join(process.cwd(), 'templates');

export const ALL_ASSET_TYPES: AssetType[] = ['battlecard', 'talk_track', 'launch_messaging', 'social_hook', 'one_pager', 'email_copy', 'messaging_template', 'narrative'];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  battlecard: 'Battlecard',
  talk_track: 'Talk Track',
  launch_messaging: 'Launch Messaging',
  social_hook: 'Social Hook',
  one_pager: 'One-Pager',
  email_copy: 'Email Copy',
  messaging_template: 'Messaging Template',
  narrative: 'Narrative',
};

function loadTemplate(assetType: AssetType): string {
  try {
    const filename = assetType.replace(/_/g, '-') + '.md';
    return readFileSync(join(TEMPLATE_DIR, filename), 'utf-8');
  } catch {
    return `Generate ${ASSET_TYPE_LABELS[assetType] || assetType} content.`;
  }
}

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
    writeFileSync(filePath, buffer);

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
    const { fileId, name } = await c.req.json();

    if (!fileId) {
      return c.json({ error: 'fileId is required' }, 400);
    }

    // Find the file on disk
    const { readdirSync } = await import('fs');
    const files = readdirSync(UPLOADS_DIR);
    const match = files.find(f => f.startsWith(fileId));

    if (!match) {
      return c.json({ error: `File ${fileId} not found` }, 404);
    }

    const filePath = join(UPLOADS_DIR, match);
    const buffer = readFileSync(filePath);
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
      // Plain text file
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
  return c.json(ALL_ASSET_TYPES.map(t => ({
    id: t,
    label: ASSET_TYPE_LABELS[t],
  })));
});

// POST /api/generate — create job, return immediately, run pipeline in background
app.post('/generate', async (c) => {
  const body = await c.req.json();
  const {
    productDocs,
    existingMessaging,
    prompt,
    voiceProfileIds,
    assetTypes: requestedTypes,
    model: requestedModel,
    pipeline: requestedPipeline,
  } = body;

  if (!productDocs || productDocs.trim().length === 0) {
    return c.json({ error: 'productDocs is required' }, 400);
  }

  const db = getDatabase();

  // Validate voice profiles upfront
  const allVoices = await db.query.voiceProfiles.findMany({
    where: eq(voiceProfiles.isActive, true),
  });

  const selectedVoiceIds = voiceProfileIds && voiceProfileIds.length > 0
    ? voiceProfileIds.filter((id: string) => allVoices.some(v => v.id === id))
    : allVoices.map(v => v.id);

  if (selectedVoiceIds.length === 0) {
    return c.json({ error: 'No voice profiles selected or available' }, 400);
  }

  const selectedAssetTypes: AssetType[] = requestedTypes && requestedTypes.length > 0
    ? requestedTypes.filter((t: string) => ALL_ASSET_TYPES.includes(t as AssetType))
    : [...ALL_ASSET_TYPES];

  // Create job row
  const jobId = generateId();
  const now = new Date().toISOString();

  await db.insert(generationJobs).values({
    id: jobId,
    status: 'pending',
    currentStep: 'Queued',
    progress: 0,
    productContext: JSON.stringify({
      productDocs,
      existingMessaging,
      prompt,
      voiceProfileIds: selectedVoiceIds,
      assetTypes: selectedAssetTypes,
      model: requestedModel || 'gemini-3-pro-preview',
      pipeline: requestedPipeline || 'standard',
    }),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  logger.info('Job created, starting background pipeline', { jobId });

  // Fire-and-forget — run pipeline in background
  runPublicGenerationJob(jobId).catch((error) => {
    logger.error('Background generation job crashed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    const db = getDatabase();
    db.update(generationJobs)
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

  return c.json({ jobId }, 202);
});

// GET /api/generate/:id — poll job status
app.get('/generate/:id', async (c) => {
  const jobId = c.req.param('id');
  const db = getDatabase();

  const job = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, jobId),
  });

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  const response: any = {
    jobId: job.id,
    status: job.status,
    currentStep: job.currentStep,
    progress: job.progress,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };

  if (job.status === 'failed') {
    response.error = job.errorMessage;
  }

  if (job.status === 'completed') {
    // Fetch generated assets for this job, grouped by asset type
    const assets = await db.query.messagingAssets.findMany({
      where: eq(messagingAssets.jobId, jobId),
    });

    const variants = await db.query.assetVariants.findMany();

    // Build results in the same shape the frontend expects
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

      // Find the variant for this asset
      const variant = variants.find(v => v.assetId === asset.id);

      byType.get(asset.assetType).variants.push({
        id: variant?.id || asset.id,
        voiceProfileId: meta.voiceId,
        voiceName: meta.voiceName,
        voiceSlug: meta.voiceSlug,
        content: asset.content,
        scores: {
          slop: asset.slopScore,
          vendorSpeak: asset.vendorSpeakScore,
          authenticity: variant?.authenticityScore ?? (asset.vendorSpeakScore != null ? Math.max(0, 10 - asset.vendorSpeakScore) : null),
          specificity: asset.specificityScore,
          persona: asset.personaAvgScore,
        },
        passesGates: variant?.passesGates ?? false,
      });
    }

    response.results = Array.from(byType.values());
    // Include research availability from job context
    const ctx = JSON.parse(job.productContext || '{}');
    response.research = ctx._researchAvailable
      ? { available: true, length: ctx._researchLength }
      : { available: false };
  }

  return c.json(response);
});

// ---------------------------------------------------------------------------
// Shared Pipeline Helpers
// ---------------------------------------------------------------------------

interface JobInputs {
  productDocs: string;
  existingMessaging?: string;
  prompt?: string;
  voiceProfileIds: string[];
  assetTypes: AssetType[];
  model: string;
  pipeline: string;
  selectedVoices: any[];
}

async function loadJobInputs(jobId: string): Promise<JobInputs> {
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

function updateJobProgress(jobId: string, fields: Record<string, any>) {
  const db = getDatabase();
  db.update(generationJobs)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(generationJobs.id, jobId))
    .run();
}

async function runCompetitiveResearch(productDocs: string, prompt?: string): Promise<string> {
  const researchPrompt = buildResearchPromptFromDocs(productDocs, prompt);
  const interactionId = await createDeepResearchInteraction(researchPrompt);
  const result = await pollInteractionUntilComplete(interactionId);
  return result.text;
}

async function runPractitionerPainResearch(productDocs: string, prompt?: string): Promise<string> {
  const searchPrompt = `Search Reddit, Hacker News, Stack Overflow, and other developer/practitioner communities for real opinions, complaints, and pain points related to the following product area.

## Product Context (brief)
${productDocs.substring(0, 3000)}

${prompt ? `## Focus Area\n${prompt}\n` : ''}

## What to Find
1. Real practitioner quotes expressing frustration with current tools in this space
2. Common complaints and pain points from community discussions
3. What practitioners wish existed or worked better
4. Specific scenarios where current solutions fail them
5. The language practitioners actually use to describe these problems

## Output Format
Return the findings organized as:
- **Practitioner Quotes**: Verbatim quotes from real community posts (include source like "Reddit r/devops" or "HN comment")
- **Common Pain Points**: Recurring themes across communities
- **Wished-For Solutions**: What practitioners say they want
- **Language Patterns**: The specific words and phrases practitioners use (not vendor language)

Be specific. Include actual quotes. This will be used to ground messaging in real practitioner language.`;

  const result = await generateWithGeminiGroundedSearch(searchPrompt, {
    maxTokens: 8192,
    temperature: 0.3,
  });
  return result.text;
}

interface GenerateAndScoreResult {
  content: string;
  scores: ScoreResults;
  passesGates: boolean;
}

async function generateAndScoreVariant(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  productDocs: string,
  thresholds: any,
  voice: any,
  assetType: AssetType,
  jobId: string,
  refine: boolean = true,
): Promise<GenerateAndScoreResult> {
  const response = await generateContent(userPrompt, {
    systemPrompt,
    temperature: 0.7,
  }, model);

  let finalContent = response.text;
  let scores = await scoreContent(finalContent, productDocs);
  let passesGates = checkGates(scores, thresholds);

  if (refine && !passesGates) {
    logger.info('Content failed gates, attempting refinement', {
      jobId, assetType, voice: voice.name,
      slop: scores.slopScore, vendor: scores.vendorSpeakScore,
      auth: scores.authenticityScore, spec: scores.specificityScore,
      persona: scores.personaAvgScore,
    });

    if (scores.slopScore > thresholds.slopMax) {
      try {
        finalContent = await deslop(finalContent, scores.slopAnalysis);
      } catch (deslopErr) {
        logger.warn('Deslop failed, continuing with original', {
          error: deslopErr instanceof Error ? deslopErr.message : String(deslopErr),
        });
      }
    }

    const refinementPrompt = buildRefinementPrompt(finalContent, scores, thresholds, voice, assetType);
    try {
      const refinedResponse = await generateContent(refinementPrompt, {
        systemPrompt,
        temperature: 0.5,
      }, model);

      const refinedScores = await scoreContent(refinedResponse.text, productDocs);

      if (totalQualityScore(refinedScores) > totalQualityScore(scores)) {
        finalContent = refinedResponse.text;
        scores = refinedScores;
        passesGates = checkGates(scores, thresholds);
      }
    } catch (refineErr) {
      logger.warn('Refinement generation failed, keeping original', {
        error: refineErr instanceof Error ? refineErr.message : String(refineErr),
      });
    }
  }

  return { content: finalContent, scores, passesGates };
}

async function storeVariant(
  jobId: string,
  assetType: AssetType,
  voice: any,
  content: string,
  scores: ScoreResults,
  passesGates: boolean,
  prompt?: string,
) {
  const db = getDatabase();
  const assetId = generateId();
  const variantId = generateId();

  await db.insert(messagingAssets).values({
    id: assetId,
    priorityId: PUBLIC_GENERATION_PRIORITY_ID,
    jobId,
    assetType,
    title: `${ASSET_TYPE_LABELS[assetType]} — ${(prompt || 'Product docs generation').substring(0, 100)}`,
    content,
    metadata: JSON.stringify({ generationId: jobId, voiceId: voice.id, voiceName: voice.name, voiceSlug: voice.slug }),
    slopScore: scores.slopScore,
    vendorSpeakScore: scores.vendorSpeakScore,
    specificityScore: scores.specificityScore,
    personaAvgScore: scores.personaAvgScore,
    status: passesGates ? 'review' : 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await db.insert(assetVariants).values({
    id: variantId,
    assetId,
    voiceProfileId: voice.id,
    variantNumber: 1,
    content,
    slopScore: scores.slopScore,
    vendorSpeakScore: scores.vendorSpeakScore,
    authenticityScore: scores.authenticityScore,
    specificityScore: scores.specificityScore,
    personaAvgScore: scores.personaAvgScore,
    passesGates,
    isSelected: false,
    createdAt: new Date().toISOString(),
  });

  await db.insert(assetTraceability).values({
    id: generateId(),
    assetId,
    practitionerQuotes: JSON.stringify([]),
    createdAt: new Date().toISOString(),
  });
}

function pickBestResult(...results: GenerateAndScoreResult[]): GenerateAndScoreResult {
  return results.reduce((best, current) =>
    totalQualityScore(current.scores) > totalQualityScore(best.scores) ? current : best
  );
}

// ---------------------------------------------------------------------------
// Pipeline: Standard (Research → Generate → Score → Refine)
// ---------------------------------------------------------------------------

async function runStandardPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  updateJobProgress(jobId, { status: 'running', currentStep: 'Running competitive research...', progress: 5 });

  let researchContext = '';
  try {
    researchContext = await runCompetitiveResearch(productDocs, prompt);
  } catch (error) {
    logger.warn('Competitive research failed, continuing without it', {
      jobId, error: error instanceof Error ? error.message : String(error),
    });
  }

  updateJobProgress(jobId, { currentStep: 'Extracting product insights...', progress: 10 });
  const extractedInsights = await extractInsights(productDocs);

  updateJobProgress(jobId, { currentStep: 'Generating messaging...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      updateJobProgress(jobId, { currentStep: `Generating ${ASSET_TYPE_LABELS[assetType]} — ${voice.name}` });

      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType);
      const userPrompt = buildUserPrompt(productDocs, existingMessaging, prompt, researchContext, template, assetType, extractedInsights);

      try {
        const result = await generateAndScoreVariant(userPrompt, systemPrompt, selectedModel, productDocs, thresholds, voice, assetType, jobId);
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, !!researchContext, researchContext.length);
}

// ---------------------------------------------------------------------------
// Pipeline: Split Research (competitive + practitioner pain in parallel)
// ---------------------------------------------------------------------------

async function runSplitResearchPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  updateJobProgress(jobId, { status: 'running', currentStep: 'Running competitive research & searching for practitioner pain...', progress: 5 });

  // Parallel research streams
  const [competitiveResult, practitionerResult, extractedInsights] = await Promise.all([
    runCompetitiveResearch(productDocs, prompt).catch(err => {
      logger.warn('Competitive research failed', { jobId, error: err instanceof Error ? err.message : String(err) });
      return '';
    }),
    runPractitionerPainResearch(productDocs, prompt).catch(err => {
      logger.warn('Practitioner pain research failed', { jobId, error: err instanceof Error ? err.message : String(err) });
      return '';
    }),
    extractInsights(productDocs),
  ]);

  updateJobProgress(jobId, { currentStep: 'Combining research...', progress: 15 });

  // Build enriched research context with separate sections
  const enrichedResearch = [
    competitiveResult ? `## Competitive Intelligence\n${competitiveResult}` : '',
    practitionerResult ? `## Practitioner Pain (from communities)\n${practitionerResult}` : '',
  ].filter(Boolean).join('\n\n');

  updateJobProgress(jobId, { currentStep: 'Generating messaging...', progress: 20 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      updateJobProgress(jobId, { currentStep: `Generating ${ASSET_TYPE_LABELS[assetType]} — ${voice.name}` });

      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType);
      const userPrompt = buildUserPrompt(productDocs, existingMessaging, prompt, enrichedResearch, template, assetType, extractedInsights);

      try {
        const result = await generateAndScoreVariant(userPrompt, systemPrompt, selectedModel, productDocs, thresholds, voice, assetType, jobId);
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(20 + (completedItems / totalItems) * 75), 95) });
    }
  }

  return finalizeJob(jobId, !!(competitiveResult || practitionerResult), (competitiveResult + practitionerResult).length);
}

// ---------------------------------------------------------------------------
// Pipeline: Outside-In (practitioner pain first, refine inward)
// ---------------------------------------------------------------------------

async function runOutsideInPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Search for practitioner pain
  updateJobProgress(jobId, { status: 'running', currentStep: 'Searching for practitioner pain...', progress: 5 });

  let practitionerContext = '';
  try {
    practitionerContext = await runPractitionerPainResearch(productDocs, prompt);
  } catch (error) {
    logger.warn('Practitioner pain research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
  }

  const extractedInsights = await extractInsights(productDocs);

  updateJobProgress(jobId, { currentStep: 'Generating pain-grounded draft...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType);

      try {
        // Step 2: Generate pain-grounded first draft (minimal product detail)
        updateJobProgress(jobId, { currentStep: `Generating pain-grounded draft — ${voice.name}` });

        const painFirstPrompt = buildPainFirstPrompt(practitionerContext, productDocs, template, assetType, extractedInsights);
        const firstDraft = await generateContent(painFirstPrompt, { systemPrompt, temperature: 0.7 }, selectedModel);

        // Step 3: Competitive research + score first draft in parallel
        updateJobProgress(jobId, { currentStep: `Running competitive research & scoring — ${voice.name}` });

        const [firstScores, competitiveContext] = await Promise.all([
          scoreContent(firstDraft.text, productDocs),
          runCompetitiveResearch(productDocs, prompt).catch(() => ''),
        ]);

        // Step 4: Refine with full product context + competitive intel
        updateJobProgress(jobId, { currentStep: `Refining with product context — ${voice.name}` });

        const refinePrompt = `Refine this ${assetType.replace(/_/g, ' ')} by layering in product specifics and competitive context.

## CRITICAL RULE: Don't lose the practitioner voice
The first draft below was written from pure practitioner pain. It sounds authentic. Your job is to ADD specifics and competitive edge WITHOUT losing that voice. If in doubt, keep the practitioner language.

## First Draft (pain-grounded)
${firstDraft.text}

## Product Documentation (add specifics from here)
${productDocs.substring(0, 6000)}

${competitiveContext ? `## Competitive Intelligence (weave in positioning)\n${competitiveContext.substring(0, 4000)}` : ''}

## Template / Format Guide
${template}

Rewrite with the product specifics and competitive positioning woven in naturally. Keep the pain-first structure. Output ONLY the refined content.`;

        const refinedResponse = await generateContent(refinePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        const refinedScores = await scoreContent(refinedResponse.text, productDocs);

        // Keep best version
        const firstResult: GenerateAndScoreResult = {
          content: firstDraft.text,
          scores: firstScores,
          passesGates: checkGates(firstScores, thresholds),
        };
        const refinedResult: GenerateAndScoreResult = {
          content: refinedResponse.text,
          scores: refinedScores,
          passesGates: checkGates(refinedScores, thresholds),
        };

        const best = pickBestResult(firstResult, refinedResult);
        await storeVariant(jobId, assetType, voice, best.content, best.scores, best.passesGates, prompt);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, !!practitionerContext, practitionerContext.length);
}

function buildPainFirstPrompt(
  practitionerContext: string,
  productDocs: string,
  template: string,
  assetType: AssetType,
  insights?: ExtractedInsights | null,
): string {
  let prompt = '';

  if (practitionerContext) {
    prompt += `## Real Practitioner Pain (this is your primary source material)
${practitionerContext}

`;
  }

  // Only include minimal product context — enough to know what we're writing about, not enough to tempt vendor-speak
  if (insights) {
    prompt += `## What the product does (brief — DO NOT lead with this)
${insights.summary}

## Pain points it addresses
${insights.painPointsAddressed.map(p => `- ${p}`).join('\n')}
`;
  } else {
    prompt += `## Product context (brief — DO NOT lead with this)
${productDocs.substring(0, 1500)}
`;
  }

  prompt += `
## Template / Format Guide
${template}

## Instructions
Write this ${assetType.replace(/_/g, ' ')} grounded ENTIRELY in practitioner pain. Use the real quotes and language from the practitioner research above. The reader should feel like someone who understands their world wrote this — not a vendor.

Minimal product mentions. Maximum practitioner empathy. Output ONLY the content.`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Pipeline: Adversarial (generate, attack, defend, finalize)
// ---------------------------------------------------------------------------

async function runAdversarialPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Research (same as standard)
  updateJobProgress(jobId, { status: 'running', currentStep: 'Running competitive research...', progress: 5 });

  let researchContext = '';
  try {
    researchContext = await runCompetitiveResearch(productDocs, prompt);
  } catch (error) {
    logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
  }

  const extractedInsights = await extractInsights(productDocs);

  updateJobProgress(jobId, { currentStep: 'Generating initial drafts...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType);
      const userPrompt = buildUserPrompt(productDocs, existingMessaging, prompt, researchContext, template, assetType, extractedInsights);

      try {
        // Step 2: Generate initial draft
        updateJobProgress(jobId, { currentStep: `Generating initial draft — ${voice.name}` });
        const initialResponse = await generateContent(userPrompt, { systemPrompt, temperature: 0.7 }, selectedModel);
        const initialScores = await scoreContent(initialResponse.text, productDocs);

        // Step 3: Attack — hostile skeptical practitioner tears it apart
        updateJobProgress(jobId, { currentStep: `Running adversarial critique — ${voice.name}` });

        const attackPrompt = `You are a hostile, skeptical senior practitioner reviewing vendor messaging. You've been burned by every vendor promise in the last decade. You hate buzzwords, vague claims, and anything that sounds like it was written by someone who has never been on-call.

Tear apart this ${assetType.replace(/_/g, ' ')} messaging. Be ruthless but specific:

## Messaging to Attack
${initialResponse.text}

## Your Critique Should Cover
1. **Unsubstantiated Claims**: What claims have zero evidence? What would you need to see to believe them?
2. **Vendor-Speak Detection**: Every phrase that sounds like marketing rather than a peer talking. Quote the exact phrases.
3. **Vague Promises**: Where does it hand-wave instead of being specific? What details are missing?
4. **Reality Check**: What would actually happen if a practitioner tried what this messaging implies? Where does it oversimplify?
5. **Missing Objections**: What obvious objections would a buyer raise that this messaging doesn't address?
6. **Credibility Gaps**: Where does this lose trust? What would make you stop reading?

Be brutal. Every weakness you find makes the final output stronger. Format as a numbered list of specific attacks.`;

        const attackResponse = await generateWithGemini(attackPrompt, {
          model: config.ai.gemini.proModel,
          temperature: 0.6,
          maxTokens: 4000,
        });

        // Step 4: Defend — rewrite to survive the attacks
        updateJobProgress(jobId, { currentStep: `Rewriting to survive objections — ${voice.name}` });

        const defendPrompt = `Your ${assetType.replace(/_/g, ' ')} messaging was attacked by a skeptical practitioner. Rewrite it to survive every objection.

## Original Messaging
${initialResponse.text}

## Practitioner Attacks
${attackResponse.text}

## Product Documentation (for evidence)
${productDocs.substring(0, 6000)}

## Rules for the Rewrite
1. For every unsubstantiated claim: either add specific evidence from the product docs, or remove the claim entirely
2. For every vendor-speak phrase: replace with practitioner language
3. For every vague promise: make it concrete with specifics, or cut it
4. Address the strongest objections directly — don't dodge them
5. Keep the same structure and format as the original
6. The result should feel battle-hardened — every remaining claim can withstand scrutiny

## Template / Format Guide
${template}

Output ONLY the rewritten content. No meta-commentary.`;

        const defendedResponse = await generateContent(defendPrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        const defendedScores = await scoreContent(defendedResponse.text, productDocs);

        // Keep best version
        const initialResult: GenerateAndScoreResult = {
          content: initialResponse.text,
          scores: initialScores,
          passesGates: checkGates(initialScores, thresholds),
        };
        const defendedResult: GenerateAndScoreResult = {
          content: defendedResponse.text,
          scores: defendedScores,
          passesGates: checkGates(defendedScores, thresholds),
        };

        const best = pickBestResult(initialResult, defendedResult);
        await storeVariant(jobId, assetType, voice, best.content, best.scores, best.passesGates, prompt);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, !!researchContext, researchContext.length);
}

// ---------------------------------------------------------------------------
// Pipeline: Multi-Perspective (3 angles, synthesize best)
// ---------------------------------------------------------------------------

async function runMultiPerspectivePipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Research
  updateJobProgress(jobId, { status: 'running', currentStep: 'Running competitive research...', progress: 5 });

  let researchContext = '';
  try {
    researchContext = await runCompetitiveResearch(productDocs, prompt);
  } catch (error) {
    logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
  }

  const extractedInsights = await extractInsights(productDocs);

  updateJobProgress(jobId, { currentStep: 'Generating from multiple perspectives...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType);

      try {
        // Step 2: Generate 3 perspectives in parallel
        const baseContext = buildUserPrompt(productDocs, existingMessaging, prompt, researchContext, template, assetType, extractedInsights);

        const empathyAngle = `${baseContext}

## PERSPECTIVE: Practitioner Empathy
Lead ENTIRELY with pain. The reader should feel seen before they see any product mention. Use their language, their frustrations, their 2am-on-call stories. Product comes last, almost as an afterthought. Make them nod before you pitch.`;

        const competitiveAngle = `${baseContext}

## PERSPECTIVE: Competitive Positioning
Lead with what current alternatives FAIL at. The reader should recognize the specific frustrations they have with their current tool. Then show what's different — not "better" (that's vendor-speak), but specifically what changes and why it matters for their workflow.`;

        const thoughtLeadershipAngle = `${baseContext}

## PERSPECTIVE: Thought Leadership
Lead with the industry's broken promise — the thing everyone was told would work but doesn't. Frame the problem as systemic, not just a tooling gap. Then present a different way of thinking about it. This should read like an opinionated blog post by someone who's seen the patterns across hundreds of teams.`;

        updateJobProgress(jobId, { currentStep: `Generating 3 perspectives — ${voice.name}` });

        const [empathyRes, competitiveRes, thoughtRes] = await Promise.all([
          generateContent(empathyAngle, { systemPrompt, temperature: 0.7 }, selectedModel),
          generateContent(competitiveAngle, { systemPrompt, temperature: 0.7 }, selectedModel),
          generateContent(thoughtLeadershipAngle, { systemPrompt, temperature: 0.7 }, selectedModel),
        ]);

        // Step 3: Synthesize the best elements
        updateJobProgress(jobId, { currentStep: `Synthesizing best elements — ${voice.name}` });

        const synthesizePrompt = `You have 3 versions of the same ${assetType.replace(/_/g, ' ')}, each written from a different angle. Take the strongest elements from each and synthesize them into one superior version.

## Version A: Practitioner Empathy
${empathyRes.text}

## Version B: Competitive Positioning
${competitiveRes.text}

## Version C: Thought Leadership
${thoughtRes.text}

## Synthesis Instructions
1. Take the most authentic pain language from Version A
2. Take the sharpest competitive positioning from Version B
3. Take the strongest narrative arc from Version C
4. Weave them into a single cohesive piece that has: authentic pain + competitive edge + compelling narrative
5. Don't just concatenate — synthesize. The result should feel like one voice, not three stitched together.
6. Keep the same format as the template below.

## Template / Format Guide
${template}

Output ONLY the synthesized content. No meta-commentary.`;

        const synthesizedResponse = await generateContent(synthesizePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);

        // Step 4: Score all 4 versions, keep the best
        const [empathyScores, competitiveScores, thoughtScores, synthesizedScores] = await Promise.all([
          scoreContent(empathyRes.text, productDocs),
          scoreContent(competitiveRes.text, productDocs),
          scoreContent(thoughtRes.text, productDocs),
          scoreContent(synthesizedResponse.text, productDocs),
        ]);

        const candidates: GenerateAndScoreResult[] = [
          { content: empathyRes.text, scores: empathyScores, passesGates: checkGates(empathyScores, thresholds) },
          { content: competitiveRes.text, scores: competitiveScores, passesGates: checkGates(competitiveScores, thresholds) },
          { content: thoughtRes.text, scores: thoughtScores, passesGates: checkGates(thoughtScores, thresholds) },
          { content: synthesizedResponse.text, scores: synthesizedScores, passesGates: checkGates(synthesizedScores, thresholds) },
        ];

        const best = pickBestResult(...candidates);
        await storeVariant(jobId, assetType, voice, best.content, best.scores, best.passesGates, prompt);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, !!researchContext, researchContext.length);
}

// ---------------------------------------------------------------------------
// Job Finalization + Pipeline Dispatch
// ---------------------------------------------------------------------------

async function finalizeJob(jobId: string, researchAvailable: boolean, researchLength: number): Promise<void> {
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

const PIPELINE_RUNNERS: Record<string, (jobId: string, inputs: JobInputs) => Promise<void>> = {
  standard: runStandardPipeline,
  'split-research': runSplitResearchPipeline,
  'outside-in': runOutsideInPipeline,
  adversarial: runAdversarialPipeline,
  'multi-perspective': runMultiPerspectivePipeline,
};

export async function runPublicGenerationJob(jobId: string): Promise<void> {
  const inputs = await loadJobInputs(jobId);
  const pipeline = inputs.pipeline || 'standard';
  const runner = PIPELINE_RUNNERS[pipeline] || PIPELINE_RUNNERS.standard;

  logger.info('Starting pipeline', { jobId, pipeline });
  await runner(jobId, inputs);
}

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

  // Group by generationId (stored in metadata)
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
      },
      status: asset.status,
      createdAt: asset.createdAt,
    });
  }

  return c.json(Array.from(generations.values()));
});

import type { AIResponse, GenerateOptions } from '../services/ai/types.js';

// ---------------------------------------------------------------------------
// Document Pre-Extraction (Change 1)
// ---------------------------------------------------------------------------

interface ExtractedInsights {
  productCapabilities: string[];
  keyDifferentiators: string[];
  targetPersonas: string[];
  painPointsAddressed: string[];
  claimsAndMetrics: string[];
  technicalDetails: string[];
  summary: string;
}

async function extractInsights(productDocs: string): Promise<ExtractedInsights | null> {
  try {
    const truncated = productDocs.substring(0, 30000);
    const prompt = `Analyze the following product documentation and extract structured insights.

## Documentation
${truncated}

Return a JSON object with these fields:
- "productCapabilities": array of specific product capabilities/features (max 12)
- "keyDifferentiators": array of what makes this product different from alternatives (max 8)
- "targetPersonas": array of who this product is for, with their roles and concerns (max 6)
- "painPointsAddressed": array of specific practitioner pain points this product solves (max 10)
- "claimsAndMetrics": array of concrete claims, numbers, benchmarks, or performance metrics (max 10)
- "technicalDetails": array of important technical details, integrations, or architecture notes (max 8)
- "summary": a 2-3 sentence summary of what this product does and why it matters

Be specific. Extract actual details, not generic descriptions. If the docs mention specific numbers, include them.

IMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`;

    const response = await generateWithGemini(prompt, {
      temperature: 0.2,
      maxTokens: 4000,
    });

    let jsonText = response.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    return JSON.parse(jsonText) as ExtractedInsights;
  } catch (error) {
    logger.warn('Document insight extraction failed, falling back to raw truncation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function formatInsightsForPrompt(insights: ExtractedInsights): string {
  const sections: string[] = [];

  sections.push(`### Product Summary\n${insights.summary}`);

  if (insights.painPointsAddressed.length > 0) {
    sections.push(`### Pain Points Addressed\n${insights.painPointsAddressed.map(p => `- ${p}`).join('\n')}`);
  }
  if (insights.productCapabilities.length > 0) {
    sections.push(`### Capabilities\n${insights.productCapabilities.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.keyDifferentiators.length > 0) {
    sections.push(`### Key Differentiators\n${insights.keyDifferentiators.map(d => `- ${d}`).join('\n')}`);
  }
  if (insights.claimsAndMetrics.length > 0) {
    sections.push(`### Claims & Metrics\n${insights.claimsAndMetrics.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.targetPersonas.length > 0) {
    sections.push(`### Target Personas\n${insights.targetPersonas.map(p => `- ${p}`).join('\n')}`);
  }
  if (insights.technicalDetails.length > 0) {
    sections.push(`### Technical Details\n${insights.technicalDetails.map(t => `- ${t}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/** Dispatches generation to the appropriate AI model based on user selection. */
async function generateContent(
  prompt: string,
  options: GenerateOptions,
  model?: string,
): Promise<AIResponse> {
  if (model && model.startsWith('gemini')) {
    return generateWithGemini(prompt, {
      ...options,
      model: config.ai.gemini.proModel,
      maxTokens: options.maxTokens ?? 16000,
    });
  }
  return generateWithClaude(prompt, { ...options, model: model || undefined });
}

// ---------------------------------------------------------------------------
// Scoring helpers (Change 4)
// ---------------------------------------------------------------------------

interface ScoreResults {
  slopScore: number;
  vendorSpeakScore: number;
  authenticityScore: number;
  specificityScore: number;
  personaAvgScore: number;
  slopAnalysis: any;
}

async function scoreContent(content: string, productDocs: string): Promise<ScoreResults> {
  const [slopAnalysis, vendorAnalysis, specificityAnalysis, personaResults] = await Promise.all([
    analyzeSlop(content).catch(() => ({ score: 5 })),
    analyzeVendorSpeak(content).catch(() => ({ score: 5 })),
    analyzeSpecificity(content, [productDocs]).catch(() => ({ score: 5 })),
    runPersonaCritics(content).catch(() => []),
  ]);

  const personaAvg = personaResults.length > 0
    ? personaResults.reduce((sum: number, r: any) => sum + r.score, 0) / personaResults.length
    : 5;

  return {
    slopScore: (slopAnalysis as any).score,
    vendorSpeakScore: (vendorAnalysis as any).score,
    authenticityScore: Math.max(0, 10 - (vendorAnalysis as any).score),
    specificityScore: (specificityAnalysis as any).score,
    personaAvgScore: Math.round(personaAvg * 10) / 10,
    slopAnalysis,
  };
}

function checkGates(scores: ScoreResults, thresholds: any): boolean {
  return (
    scores.slopScore <= thresholds.slopMax &&
    scores.vendorSpeakScore <= thresholds.vendorSpeakMax &&
    scores.authenticityScore >= thresholds.authenticityMin &&
    scores.specificityScore >= thresholds.specificityMin &&
    scores.personaAvgScore >= thresholds.personaMin
  );
}

function totalQualityScore(scores: ScoreResults): number {
  // Higher is better: invert slop and vendor (where lower is better)
  return (10 - scores.slopScore) + (10 - scores.vendorSpeakScore) +
    scores.authenticityScore + scores.specificityScore + scores.personaAvgScore;
}

function buildRefinementPrompt(
  content: string,
  scores: ScoreResults,
  thresholds: any,
  voice: any,
  assetType: AssetType,
): string {
  const issues: string[] = [];

  if (scores.slopScore > thresholds.slopMax) {
    issues.push(`- **Slop**: ${scores.slopScore.toFixed(1)}/10 (max ${thresholds.slopMax}). Remove filler phrases, hedging language, and cliched transitions. Every word must earn its place.`);
  }
  if (scores.vendorSpeakScore > thresholds.vendorSpeakMax) {
    issues.push(`- **Vendor-Speak**: ${scores.vendorSpeakScore.toFixed(1)}/10 (max ${thresholds.vendorSpeakMax}). Replace self-congratulatory vendor language with practitioner-focused language. Sound like a peer, not a marketer.`);
  }
  if (scores.authenticityScore < thresholds.authenticityMin) {
    issues.push(`- **Authenticity**: ${scores.authenticityScore.toFixed(1)}/10 (min ${thresholds.authenticityMin}). Make it sound like a real human wrote this. Add specific scenarios, real-world context, and genuine insight.`);
  }
  if (scores.specificityScore < thresholds.specificityMin) {
    issues.push(`- **Specificity**: ${scores.specificityScore.toFixed(1)}/10 (min ${thresholds.specificityMin}). Replace vague claims with concrete details — names, numbers, specific capabilities, real scenarios.`);
  }
  if (scores.personaAvgScore < thresholds.personaMin) {
    issues.push(`- **Persona Fit**: ${scores.personaAvgScore.toFixed(1)}/10 (min ${thresholds.personaMin}). Better match the ${voice.name} voice. The content should resonate with the target audience.`);
  }

  return `Rewrite this ${assetType.replace(/_/g, ' ')} to fix the following quality issues:

${issues.join('\n')}

## Content to Rewrite
${content}

## Rules
1. Fix ONLY the flagged issues — don't change what's already working
2. Keep the same structure and format
3. Keep all factual claims and specific details
4. Don't introduce new slop while fixing other issues
5. Output ONLY the rewritten content, nothing else`;
}

function buildResearchPromptFromDocs(productDocs: string, prompt?: string): string {
  return `Conduct competitive research based on the following product documentation.

## Product Documentation
${productDocs.substring(0, 10000)}

${prompt ? `## Focus Area\n${prompt}\n` : ''}

## Research Questions

1. **Competitor Landscape**: Based on the product described, identify the main competitors. How do they approach the same problems? What are their key differentiators?

2. **Market Positioning**: Where does this product have the strongest competitive advantage? What specific capabilities differentiate it?

3. **Practitioner Pain Points**: What do real practitioners say about this problem space? Check Reddit, Stack Overflow, Hacker News for authentic opinions. Include verbatim quotes.

4. **Competitive Gaps**: Where do competitors fall short? What pain points remain unaddressed by existing solutions?

5. **Market Trends**: What industry trends make this product more relevant? Is the problem growing or shrinking?

## Output Requirements
- Be specific and factual, cite sources
- Include actual practitioner quotes from forums/communities
- Don't use marketing language — write like an analyst
- Focus on what actually works vs what vendors claim`;
}

// ---------------------------------------------------------------------------
// Persona-specific generation angles (Change 3)
// ---------------------------------------------------------------------------

const PERSONA_ANGLES: Record<string, string> = {
  'practitioner-community': `You are writing for practitioners — the people who actually do the work.
Lead with the daily frustration. The reader should think "that's exactly my Tuesday."
Every claim must pass the test: "Would an SRE share this in Slack?"
Use the language of someone who has been on-call, debugged at 2am, and is skeptical of vendor promises.
No exec-speak, no vision statements — just what's broken and how this fixes it.`,

  'sales-enablement': `You are arming a sales team to have credible technical conversations.
Lead with what the prospect is experiencing — the pain they'll nod along to.
Write like you're coaching someone for a whiteboard session, not handing them a script.
Include "trap questions" the prospect might ask and how to answer honestly.
Every talking point should survive a skeptical technical buyer pushing back.`,

  'product-launch': `You are writing launch messaging that cuts through noise.
Lead with a bold headline built on the "broken promise" — what the industry promised but never delivered.
Create vivid before/after contrast: the painful status quo vs. the new reality.
This should feel like a manifesto, not a feature list.
Make the reader feel the cost of the old way before showing the new way.`,

  'field-marketing': `You are writing for field marketers who need to capture attention in 30 seconds.
Lead with a relatable scenario — something the reader has personally experienced.
Build progressive understanding: hook → recognition → "tell me more."
Make it scannable — someone scrolling on their phone should get the core message.
Every section should pass the 30-second attention test: would they keep reading?`,
};

function buildSystemPrompt(voice: any, assetType: AssetType): string {
  let typeInstructions = '';

  if (assetType === 'messaging_template') {
    typeInstructions = `

## Messaging Template Instructions
You are generating a comprehensive messaging positioning document (3000-5000 words).
This is a single, complete document — not a summary. Fill every section fully.
Include: Background/Market Trends, Key Message (8-12 word headline), Sub-Head alternatives,
Customer Promises (3-4 blocks with name/tagline/description), Proof Points grounded in product docs,
Priority Use Cases, Problem Statement, Short/Medium/Long descriptions, and Customer Proof Points.
All claims MUST be traceable to the provided source material.`;
  } else if (assetType === 'narrative') {
    typeInstructions = `

## Narrative Instructions
You are generating a storytelling narrative document with 3 length variants in a single output.
VARIANT 1 (~250 words): Executive summary — thesis + problem + vision.
VARIANT 2 (~1000 words): Conference talk — hook, problem, why current approaches fail, the vision, taglines.
VARIANT 3 (~2500 words): Full narrative — thesis, broken promise, life in the trenches, root cause analysis,
new approach, what changes, future state, taglines.
Each variant must be standalone and readable on its own. Use thought-leadership tone.
Weave practitioner quotes naturally throughout. Mark each variant clearly with headers.`;
  }

  // Look up persona-specific angle
  const personaAngle = PERSONA_ANGLES[voice.slug] || '';

  return `You are a messaging strategist generating ${assetType.replace(/_/g, ' ')} content.

## Primary Directive
Lead with the pain. The reader should recognize their frustration in the first two sentences.
Do not open with what the product does. Open with what's broken, what hurts, what the reader is struggling with today.
Then — and only then — show how things change.

${personaAngle ? `## Persona Angle\n${personaAngle}\n` : ''}
## Voice Profile: ${voice.name}
${voice.voiceGuide}
${typeInstructions}

## Critical Rules
1. Ground ALL claims in the product documentation and competitive research — no invented claims
2. Use practitioner language, not vendor language
3. Reference specific capabilities, not generic value props
4. If practitioner quotes are available, weave them in naturally
5. Every claim must be traceable to the product docs or research
6. Sound like someone who understands the practitioner's world, not someone selling to them
7. Be specific — names, numbers, scenarios. Vague messaging is bad messaging.
8. DO NOT use: "industry-leading", "best-in-class", "next-generation", "enterprise-grade", "mission-critical", "turnkey", "end-to-end", "single pane of glass", "seamless", "robust", "leverage", "cutting-edge", "game-changer"`;
}

function buildUserPrompt(
  productDocs: string,
  existingMessaging: string | undefined,
  prompt: string | undefined,
  researchContext: string,
  template: string,
  assetType: AssetType,
  insights?: ExtractedInsights | null,
): string {
  const isLongForm = assetType === 'messaging_template' || assetType === 'narrative';

  let userPrompt = '';

  if (insights) {
    // Lead with pain, then product intelligence, with a raw excerpt for grounding
    const rawExcerptLimit = isLongForm ? 4000 : 2000;

    // Pain section first
    if (insights.painPointsAddressed.length > 0) {
      userPrompt = `## The Pain (lead with this)
These are the real practitioner pain points this product addresses. Your opening should make the reader feel one of these:
${insights.painPointsAddressed.map(p => `- ${p}`).join('\n')}

`;
    }

    userPrompt += `## Product Intelligence (distilled)
${formatInsightsForPrompt(insights)}

## Raw Documentation Excerpt (for grounding)
${productDocs.substring(0, rawExcerptLimit)}`;
  } else {
    // Fallback: raw truncation
    const docsLimit = isLongForm ? 16000 : 8000;
    userPrompt = `## Product Documentation
${productDocs.substring(0, docsLimit)}`;
  }

  if (existingMessaging) {
    userPrompt += `\n\n## Existing Messaging (for reference/improvement)
${existingMessaging.substring(0, 4000)}`;
  }

  if (researchContext) {
    userPrompt += `\n\n## Competitive Research
${researchContext.substring(0, 6000)}`;
  }

  if (prompt) {
    userPrompt += `\n\n## Focus / Instructions
${prompt}`;
  }

  userPrompt += `\n\n## Template / Format Guide
${template}

Generate the messaging now. Start with the pain. Output ONLY the messaging content, no meta-commentary.`;

  return userPrompt;
}

export default app;
