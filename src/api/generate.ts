// Public API: POST /api/generate and GET /api/voices
// No auth required — this is the primary "dump docs, get messaging" experience

import { Hono } from 'hono';
import { getDatabase } from '../db/index.js';
import { voiceProfiles, messagingAssets, assetVariants, assetTraceability, generationJobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/hash.js';
import { generateWithClaude, generateWithGemini } from '../services/ai/clients.js';
import { config } from '../config.js';
import { createDeepResearchInteraction, pollInteractionUntilComplete } from '../services/research/deep-research.js';
import { PUBLIC_GENERATION_PRIORITY_ID } from '../db/seed.js';
import { deslop } from '../services/quality/slop-detector.js';
import { scoreContent, checkQualityGates as checkGates, totalQualityScore, type ScoreResults } from '../services/quality/score-content.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AssetType } from '../services/generation/types.js';
import { validateGrounding } from '../services/quality/grounding-validator.js';
import {
  extractInsights,
  buildFallbackInsights,
  formatInsightsForDiscovery,
  formatInsightsForResearch,
  formatInsightsForPrompt,
  formatInsightsForScoring,
  type ExtractedInsights,
} from '../services/product/insights.js';
import { nameSessionFromInsights } from '../services/workspace/sessions.js';

const UPLOADS_DIR = join(process.cwd(), 'data', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const logger = createLogger('api:generate');

// ---------------------------------------------------------------------------
// Evidence Bundle — threads community evidence through the entire pipeline
// ---------------------------------------------------------------------------

export interface PractitionerQuote {
  text: string;
  source: string;
  sourceUrl: string;
}

export interface EvidenceBundle {
  communityPostCount: number;
  practitionerQuotes: PractitionerQuote[];
  communityContextText: string;
  evidenceLevel: 'strong' | 'partial' | 'product-only';
  // strong: >= 3 community posts from >= 2 sources
  // partial: >= 1 community post or grounded search results
  // product-only: no community evidence found
  sourceCounts: Record<string, number>;
}

function classifyEvidenceLevel(
  postCount: number,
  sourceTypes: Set<string>,
  hasGroundedSearch: boolean,
): EvidenceBundle['evidenceLevel'] {
  if (postCount >= 3 && sourceTypes.size >= 2) return 'strong';
  if (postCount >= 1 || hasGroundedSearch) return 'partial';
  return 'product-only';
}


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

export function loadTemplate(assetType: AssetType): string {
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

// ---------------------------------------------------------------------------
// Community Deep Research — replaces inline grounded search + adapter calls
// ---------------------------------------------------------------------------

async function runCommunityDeepResearch(insights: ExtractedInsights, prompt?: string): Promise<EvidenceBundle> {
  const emptyBundle: EvidenceBundle = {
    communityPostCount: 0,
    practitionerQuotes: [],
    communityContextText: '',
    evidenceLevel: 'product-only',
    sourceCounts: {},
  };

  const discoveryContext = formatInsightsForDiscovery(insights);

  const deepResearchPrompt = `Search Reddit, Hacker News, Stack Overflow, GitHub Issues, developer blogs, and other practitioner communities for real discussions, complaints, and pain points related to this product area.

## Product Area
${discoveryContext}

${prompt ? `## Focus Area\n${prompt}\n` : ''}
## What to Find
1. Real practitioner quotes expressing frustration with current tools in this space
2. Common complaints and pain points from community discussions
3. What practitioners wish existed or worked better
4. Specific scenarios where current solutions fail them
5. The language practitioners actually use to describe these problems

## Output Format
Organize findings as:
- **Practitioner Quotes**: Verbatim quotes from real community posts (include source URL and community name like "Reddit r/devops" or "HN comment")
- **Common Pain Points**: Recurring themes across communities
- **Wished-For Solutions**: What practitioners say they want
- **Language Patterns**: The specific words and phrases practitioners use (not vendor language)

Be specific. Include actual quotes with source URLs.`;

  try {
    const interactionId = await createDeepResearchInteraction(deepResearchPrompt);
    const result = await pollInteractionUntilComplete(interactionId);

    const practitionerQuotes: PractitionerQuote[] = result.sources.map(s => ({
      text: s.snippet || s.title,
      source: (() => { try { return new URL(s.url).hostname.replace('www.', ''); } catch { return 'web'; } })(),
      sourceUrl: s.url,
    }));

    const uniqueHosts = new Set(result.sources.map(s => {
      try { return new URL(s.url).hostname; } catch { return 'unknown'; }
    }));

    const sourceCounts: Record<string, number> = { deep_research: 1 };
    for (const host of uniqueHosts) {
      sourceCounts[host] = (sourceCounts[host] || 0) + 1;
    }

    const evidenceLevel = classifyEvidenceLevel(
      result.sources.length,
      uniqueHosts,
      result.text.length > 100,
    );

    let contextText = '## Verified Community Evidence (USE ONLY THESE)\n\n';
    contextText += result.text + '\n\n';
    if (result.sources.length > 0) {
      contextText += 'Sources:\n';
      for (const s of result.sources) {
        contextText += `- [${s.title}](${s.url})\n`;
      }
    }

    logger.info('Community Deep Research complete', {
      sourceUrls: result.sources.length,
      uniqueHosts: uniqueHosts.size,
      evidenceLevel,
      textLength: result.text.length,
    });

    return {
      communityPostCount: result.sources.length,
      practitionerQuotes,
      communityContextText: contextText,
      evidenceLevel,
      sourceCounts,
    };
  } catch (error) {
    logger.error('Community Deep Research failed', { error: error instanceof Error ? error.message : String(error) });
    return emptyBundle;
  }
}

function updateJobProgress(jobId: string, fields: Record<string, any>) {
  const db = getDatabase();
  db.update(generationJobs)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(generationJobs.id, jobId))
    .run();
}

async function runCompetitiveResearch(insights: ExtractedInsights, prompt?: string): Promise<string> {
  const researchPrompt = buildResearchPromptFromInsights(insights, prompt);
  const interactionId = await createDeepResearchInteraction(researchPrompt);
  const result = await pollInteractionUntilComplete(interactionId);
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
  scoringContext: string,
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
  let scores = await scoreContent(finalContent, [scoringContext]);
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

      const refinedScores = await scoreContent(refinedResponse.text, [scoringContext]);

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
  evidence?: EvidenceBundle,
) {
  const db = getDatabase();
  const assetId = generateId();
  const variantId = generateId();

  // Run grounding validation — strip fabrications if no real evidence
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
    passesGates,
    isSelected: false,
    createdAt: new Date().toISOString(),
  });

  // Store real practitioner quotes from the evidence bundle
  await db.insert(assetTraceability).values({
    id: generateId(),
    assetId,
    practitionerQuotes: JSON.stringify(evidence?.practitionerQuotes ?? []),
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

  // Step 0: Extract insights once — single source of truth for all downstream uses
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);

  // Step 1: Community Deep Research + Competitive Research in parallel
  updateJobProgress(jobId, { currentStep: 'Running community & competitive research...', progress: 5 });

  const [evidence, competitiveResult] = await Promise.all([
    runCommunityDeepResearch(insights, prompt),
    runCompetitiveResearch(insights, prompt).catch(error => {
      logger.warn('Competitive research failed, continuing without it', {
        jobId, error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }),
  ]);

  let researchContext = competitiveResult;
  if (evidence.communityContextText) {
    researchContext = researchContext
      ? `${researchContext}\n\n${evidence.communityContextText}`
      : evidence.communityContextText;
  }

  updateJobProgress(jobId, { currentStep: 'Generating messaging...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      updateJobProgress(jobId, { currentStep: `Generating ${ASSET_TYPE_LABELS[assetType]} — ${voice.name}` });

      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel);
      const userPrompt = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);

      try {
        const result = await generateAndScoreVariant(userPrompt, systemPrompt, selectedModel, scoringContext, thresholds, voice, assetType, jobId);
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(18 + (completedItems / totalItems) * 77), 95) });
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

  // Step 0: Extract insights once — needed before parallel research streams
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);

  updateJobProgress(jobId, { currentStep: 'Running community & competitive research...', progress: 5 });

  // Parallel research streams: community Deep Research + competitive Deep Research
  const [evidence, competitiveResult] = await Promise.all([
    runCommunityDeepResearch(insights, prompt),
    runCompetitiveResearch(insights, prompt).catch(err => {
      logger.warn('Competitive research failed', { jobId, error: err instanceof Error ? err.message : String(err) });
      return '';
    }),
  ]);

  updateJobProgress(jobId, { currentStep: 'Combining research...', progress: 15 });

  const enrichedResearch = [
    competitiveResult ? `## Competitive Intelligence\n${competitiveResult}` : '',
    evidence.communityContextText || '',
  ].filter(Boolean).join('\n\n');

  updateJobProgress(jobId, { currentStep: 'Generating messaging...', progress: 20 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      updateJobProgress(jobId, { currentStep: `Generating ${ASSET_TYPE_LABELS[assetType]} — ${voice.name}` });

      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel);
      const userPrompt = buildUserPrompt(existingMessaging, prompt, enrichedResearch, template, assetType, insights, evidence.evidenceLevel);

      try {
        const result = await generateAndScoreVariant(userPrompt, systemPrompt, selectedModel, scoringContext, thresholds, voice, assetType, jobId);
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence);
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

  return finalizeJob(jobId, !!(competitiveResult || evidence.communityContextText), (competitiveResult + evidence.communityContextText).length);
}

// ---------------------------------------------------------------------------
// Pipeline: Outside-In (practitioner pain first, refine inward)
// ---------------------------------------------------------------------------

async function runOutsideInPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 0: Extract insights once
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);

  // Step 1: Community Deep Research — practitioner pain is the foundation
  updateJobProgress(jobId, { currentStep: 'Running community Deep Research...', progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);

  // Outside-in pipeline requires community evidence — it's the whole point
  if (evidence.evidenceLevel === 'product-only') {
    logger.warn('Outside-in pipeline requires community evidence but none was found. Falling back to standard pipeline.', { jobId });
    updateJobProgress(jobId, { currentStep: 'No community evidence found — falling back to standard pipeline...' });
    return runStandardPipeline(jobId, inputs);
  }

  const practitionerContext = evidence.communityContextText;

  updateJobProgress(jobId, { currentStep: 'Generating pain-grounded draft...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel);

      try {
        // Step 2: Generate pain-grounded first draft (minimal product detail)
        updateJobProgress(jobId, { currentStep: `Generating pain-grounded draft — ${voice.name}` });

        const painFirstPrompt = buildPainFirstPrompt(practitionerContext, template, assetType, insights);
        const firstDraft = await generateContent(painFirstPrompt, { systemPrompt, temperature: 0.7 }, selectedModel);

        // Step 3: Competitive research + score first draft in parallel
        updateJobProgress(jobId, { currentStep: `Running competitive research & scoring — ${voice.name}` });

        const [firstScores, competitiveContext] = await Promise.all([
          scoreContent(firstDraft.text, [scoringContext]),
          runCompetitiveResearch(insights, prompt).catch(() => ''),
        ]);

        // Step 4: Refine with full product context + competitive intel
        updateJobProgress(jobId, { currentStep: `Refining with product context — ${voice.name}` });

        const productInsightsText = formatInsightsForPrompt(insights);
        const refinePrompt = `Refine this ${assetType.replace(/_/g, ' ')} by layering in product specifics and competitive context.

## CRITICAL RULE: Don't lose the practitioner voice
The first draft below was written from pure practitioner pain. It sounds authentic. Your job is to ADD specifics and competitive edge WITHOUT losing that voice. If in doubt, keep the practitioner language.

## First Draft (pain-grounded)
${firstDraft.text}

## Product Intelligence (add specifics from here)
${productInsightsText}

${competitiveContext ? `## Competitive Intelligence (weave in positioning)\n${competitiveContext.substring(0, 4000)}` : ''}

## Template / Format Guide
${template}

Rewrite with the product specifics and competitive positioning woven in naturally. Keep the pain-first structure. Output ONLY the refined content.`;

        const refinedResponse = await generateContent(refinePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        const refinedScores = await scoreContent(refinedResponse.text, [scoringContext]);

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
        await storeVariant(jobId, assetType, voice, best.content, best.scores, best.passesGates, prompt, evidence);
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

  return finalizeJob(jobId, !!practitionerContext, practitionerContext?.length ?? 0);
}

function buildPainFirstPrompt(
  practitionerContext: string,
  template: string,
  assetType: AssetType,
  insights: ExtractedInsights,
): string {
  let prompt = '';

  if (practitionerContext) {
    prompt += `## Real Practitioner Pain (this is your primary source material)
${practitionerContext}

`;
  }

  // Only include minimal product context — enough to know what we're writing about, not enough to tempt vendor-speak
  prompt += `## What the product does (brief — DO NOT lead with this)
${insights.summary}

## Pain points it addresses
${insights.painPointsAddressed.map(p => `- ${p}`).join('\n')}
`;

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

  // Step 0: Extract insights once
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);

  // Step 1: Community Deep Research + Competitive Research in parallel
  updateJobProgress(jobId, { currentStep: 'Running community & competitive research...', progress: 5 });

  const [evidence, competitiveResult] = await Promise.all([
    runCommunityDeepResearch(insights, prompt),
    runCompetitiveResearch(insights, prompt).catch(error => {
      logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
      return '';
    }),
  ]);

  let researchContext = competitiveResult;
  if (evidence.communityContextText) {
    researchContext = researchContext
      ? `${researchContext}\n\n${evidence.communityContextText}`
      : evidence.communityContextText;
  }

  updateJobProgress(jobId, { currentStep: 'Generating initial drafts...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel);
      const userPrompt = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);

      try {
        // Step 2: Generate initial draft
        updateJobProgress(jobId, { currentStep: `Generating initial draft — ${voice.name}` });
        const initialResponse = await generateContent(userPrompt, { systemPrompt, temperature: 0.7 }, selectedModel);
        const initialScores = await scoreContent(initialResponse.text, [scoringContext]);

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
        });

        // Step 4: Defend — rewrite to survive the attacks
        updateJobProgress(jobId, { currentStep: `Rewriting to survive objections — ${voice.name}` });

        const productInsightsText = formatInsightsForPrompt(insights);
        const defendPrompt = `Your ${assetType.replace(/_/g, ' ')} messaging was attacked by a skeptical practitioner. Rewrite it to survive every objection.

## Original Messaging
${initialResponse.text}

## Practitioner Attacks
${attackResponse.text}

## Product Intelligence (for evidence)
${productInsightsText}

## Rules for the Rewrite
1. For every unsubstantiated claim: either add specific evidence from the product intelligence, or remove the claim entirely
2. For every vendor-speak phrase: replace with practitioner language
3. For every vague promise: make it concrete with specifics, or cut it
4. Address the strongest objections directly — don't dodge them
5. Keep the same structure and format as the original
6. The result should feel battle-hardened — every remaining claim can withstand scrutiny

## Template / Format Guide
${template}

Output ONLY the rewritten content. No meta-commentary.`;

        const defendedResponse = await generateContent(defendPrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        const defendedScores = await scoreContent(defendedResponse.text, [scoringContext]);

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
        await storeVariant(jobId, assetType, voice, best.content, best.scores, best.passesGates, prompt, evidence);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(18 + (completedItems / totalItems) * 77), 95) });
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

  // Step 0: Extract insights once
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);

  // Step 1: Community Deep Research + Competitive Research in parallel
  updateJobProgress(jobId, { currentStep: 'Running community & competitive research...', progress: 5 });

  const [evidence, competitiveResult] = await Promise.all([
    runCommunityDeepResearch(insights, prompt),
    runCompetitiveResearch(insights, prompt).catch(error => {
      logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
      return '';
    }),
  ]);

  let researchContext = competitiveResult;
  if (evidence.communityContextText) {
    researchContext = researchContext
      ? `${researchContext}\n\n${evidence.communityContextText}`
      : evidence.communityContextText;
  }

  updateJobProgress(jobId, { currentStep: 'Generating from multiple perspectives...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel);

      try {
        // Step 2: Generate 3 perspectives in parallel
        const baseContext = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);

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
          scoreContent(empathyRes.text, [scoringContext]),
          scoreContent(competitiveRes.text, [scoringContext]),
          scoreContent(thoughtRes.text, [scoringContext]),
          scoreContent(synthesizedResponse.text, [scoringContext]),
        ]);

        const candidates: GenerateAndScoreResult[] = [
          { content: empathyRes.text, scores: empathyScores, passesGates: checkGates(empathyScores, thresholds) },
          { content: competitiveRes.text, scores: competitiveScores, passesGates: checkGates(competitiveScores, thresholds) },
          { content: thoughtRes.text, scores: thoughtScores, passesGates: checkGates(thoughtScores, thresholds) },
          { content: synthesizedResponse.text, scores: synthesizedScores, passesGates: checkGates(synthesizedScores, thresholds) },
        ];

        const best = pickBestResult(...candidates);
        await storeVariant(jobId, assetType, voice, best.content, best.scores, best.passesGates, prompt, evidence);
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(18 + (completedItems / totalItems) * 77), 95) });
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

/** Dispatches generation to the appropriate AI model. Default is Gemini Pro.
 *  Claude is used only when explicitly selected (model contains 'claude'). */
export async function generateContent(
  prompt: string,
  options: GenerateOptions,
  model?: string,
): Promise<AIResponse> {
  if (model && model.includes('claude')) {
    return generateWithClaude(prompt, { ...options, model });
  }
  // Default: Gemini Pro for all generation
  return generateWithGemini(prompt, {
    ...options,
    model: config.ai.gemini.proModel,
    maxTokens: options.maxTokens ?? 16000,
  });
}

// ---------------------------------------------------------------------------
// Scoring helpers — delegated to shared module (imported at top of file)
// ---------------------------------------------------------------------------

export function buildRefinementPrompt(
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

function buildResearchPromptFromInsights(insights: ExtractedInsights, prompt?: string): string {
  const productContext = formatInsightsForResearch(insights);

  return `Conduct competitive research based on the following product context.

## Product Context
${productContext}

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

export const PERSONA_ANGLES: Record<string, string> = {
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

export function buildSystemPrompt(voice: any, assetType: AssetType, evidenceLevel?: EvidenceBundle['evidenceLevel']): string {
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
8. DO NOT use: "industry-leading", "best-in-class", "next-generation", "enterprise-grade", "mission-critical", "turnkey", "end-to-end", "single pane of glass", "seamless", "robust", "leverage", "cutting-edge", "game-changer"

## Evidence Grounding Rules
${evidenceLevel === 'product-only' ? `CRITICAL: You have NO community evidence for this generation. Do NOT fabricate practitioner quotes or use phrases like "practitioners say...", "as one engineer noted...", "community sentiment suggests...", "teams report...", or "according to engineers on Reddit...". Write from product documentation only. Where practitioner validation would strengthen a point, write: "[Needs community validation]".` : `You have real community evidence in the prompt. ONLY reference practitioners and quotes from the "Verified Community Evidence" section. Do NOT fabricate additional quotes or community references beyond what is provided. Every practitioner reference must come from that section.`}`;
}

export function buildUserPrompt(
  existingMessaging: string | undefined,
  prompt: string | undefined,
  researchContext: string,
  template: string,
  assetType: AssetType,
  insights: ExtractedInsights,
  evidenceLevel?: EvidenceBundle['evidenceLevel'],
): string {
  let userPrompt = '';

  // Lead with pain, then product intelligence
  if (insights.painPointsAddressed.length > 0) {
    userPrompt = `## The Pain (lead with this)
These are the real practitioner pain points this product addresses. Your opening should make the reader feel one of these:
${insights.painPointsAddressed.map(p => `- ${p}`).join('\n')}

`;
  }

  userPrompt += `## Product Intelligence (distilled)
${formatInsightsForPrompt(insights)}`;

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
