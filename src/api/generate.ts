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
  extractDeepPoV,
  formatDeepPoVForPrompt,
  type DeepPoVInsights,
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


export const ASSET_TYPE_TEMPERATURE: Record<AssetType, number> = {
  social_hook: 0.85,
  narrative: 0.8,
  email_copy: 0.75,
  launch_messaging: 0.7,
  one_pager: 0.6,
  talk_track: 0.65,
  battlecard: 0.55,
  messaging_template: 0.5,
};

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
// Pipeline Step Events — for live streaming UI
// ---------------------------------------------------------------------------

function emitPipelineStep(jobId: string, step: string, status: 'running' | 'complete', data?: { draft?: string; scores?: any }) {
  const db = getDatabase();
  const job = db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).get();
  const steps = JSON.parse((job as any)?.pipelineSteps || '[]');

  if (status === 'running') {
    steps.push({ step, status, startedAt: new Date().toISOString() });
  } else {
    const existing = steps.findLast((s: any) => s.step === step);
    if (existing) {
      existing.status = 'complete';
      existing.completedAt = new Date().toISOString();
      if (data?.draft) existing.draft = data.draft.substring(0, 2000);
      if (data?.scores) existing.scores = data.scores;
    }
  }

  db.update(generationJobs)
    .set({ pipelineSteps: JSON.stringify(steps), updatedAt: new Date().toISOString() })
    .where(eq(generationJobs.id, jobId))
    .run();
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

// ---------------------------------------------------------------------------
// Generate and Score (no refinement — that's handled by refinementLoop)
// ---------------------------------------------------------------------------

interface GenerateAndScoreResult {
  content: string;
  scores: ScoreResults;
  passesGates: boolean;
}

async function generateAndScore(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  scoringContext: string,
  thresholds: any,
  assetType?: AssetType,
): Promise<GenerateAndScoreResult> {
  const temperature = assetType ? ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7 : 0.7;
  const response = await generateContent(userPrompt, {
    systemPrompt,
    temperature,
  }, model);

  const scores = await scoreContent(response.text, [scoringContext]);
  const passesGates = checkGates(scores, thresholds);

  return { content: response.text, scores, passesGates };
}

// ---------------------------------------------------------------------------
// Shared Refinement Loop — all pipelines call this at the end
// ---------------------------------------------------------------------------

async function refinementLoop(
  content: string,
  scoringContext: string,
  thresholds: any,
  voice: any,
  assetType: AssetType,
  systemPrompt: string,
  model: string,
  maxIterations: number = 3,
): Promise<GenerateAndScoreResult> {
  let scores = await scoreContent(content, [scoringContext]);
  let wasDeslopped = false;

  for (let i = 0; i < maxIterations; i++) {
    if (checkGates(scores, thresholds)) break;

    // Deslop if slop is high
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

    // Build refinement prompt from failing scores
    const refinementPrompt = buildRefinementPrompt(content, scores, thresholds, voice, assetType, wasDeslopped);
    try {
      const refined = await generateContent(refinementPrompt, {
        systemPrompt,
        temperature: 0.5,
      }, model);

      const newScores = await scoreContent(refined.text, [scoringContext]);

      // If no improvement, stop (plateau)
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

async function storeVariant(
  jobId: string,
  assetType: AssetType,
  voice: any,
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
    generationPrompt: generationPrompts ? JSON.stringify({
      system: generationPrompts.systemPrompt.substring(0, 10000),
      user: generationPrompts.userPrompt.substring(0, 20000),
      timestamp: new Date().toISOString(),
    }) : null,
    createdAt: new Date().toISOString(),
  });
}


// ---------------------------------------------------------------------------
// Pipeline: Straight Through (extract insights → generate → score, no research/refinement)
// ---------------------------------------------------------------------------

async function runStraightThroughPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, selectedVoices } = inputs;

  if (!existingMessaging || existingMessaging.trim().length === 0) {
    logger.error('Straight-through pipeline requires existing messaging content to score', { jobId });
    updateJobProgress(jobId, { status: 'failed', currentStep: 'No existing messaging provided. Straight Through mode scores existing content \xe2\x80\x94 paste your messaging to evaluate it.' });
    return;
  }

  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 0: Extract insights (needed for scoring context)
  emitPipelineStep(jobId, 'extract-insights', 'running');
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 5 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(() => {});
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'extract-insights', 'complete');

  updateJobProgress(jobId, { currentStep: 'Scoring existing content...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    for (const voice of selectedVoices) {
      emitPipelineStep(jobId, `score-${assetType}-${voice.slug}`, 'running');
      updateJobProgress(jobId, { currentStep: `Scoring ${ASSET_TYPE_LABELS[assetType]} \xe2\x80\x94 ${voice.name}` });

      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');

      try {
        // Score the existing content as-is \xe2\x80\x94 NO generation, NO transformation
        const scores = await scoreContent(existingMessaging, [scoringContext]);
        const passesGates = checkGates(scores, thresholds);

        await storeVariant(jobId, assetType, voice, existingMessaging, scores, passesGates, prompt);

        emitPipelineStep(jobId, `score-${assetType}-${voice.slug}`, 'complete', {
          draft: existingMessaging,
          scores,
        });
      } catch (error) {
        logger.error('Failed to score content', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, false, 0);
}

// ---------------------------------------------------------------------------
// Pipeline: Standard (Research → Generate → Refinement Loop → Store)
// ---------------------------------------------------------------------------

async function runStandardPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 0: Deep PoV Extraction (Gemini Pro — deeper narrative analysis)
  emitPipelineStep(jobId, 'deep-pov-extraction', 'running');
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting deep product PoV (thesis, narrative, claims)...', progress: 2 });
  const povInsights = await extractDeepPoV(productDocs);
  const insights: ExtractedInsights = povInsights ?? await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const deepPoV = povInsights; // null if extraction failed — falls back to standard flow
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'deep-pov-extraction', 'complete');

  // Pre-generate banned words for each voice (cached per voice+domain)
  const voiceBannedWords = new Map<string, string[]>();
  await Promise.all(selectedVoices.map(async (voice) => {
    voiceBannedWords.set(voice.id, await getBannedWordsForVoice(voice, insights));
  }));

  // Step 1: Community research — purpose is VALIDATION of our PoV, not discovery
  emitPipelineStep(jobId, 'community-validation', 'running');
  updateJobProgress(jobId, { currentStep: 'Validating PoV against community reality...', progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);
  emitPipelineStep(jobId, 'community-validation', 'complete');

  // Step 2: Competitive research — informed by community findings
  emitPipelineStep(jobId, 'competitive-research', 'running');
  updateJobProgress(jobId, { currentStep: 'Running competitive research...', progress: 10 });
  let competitivePromptExtra = prompt || '';
  if (evidence.communityContextText) {
    competitivePromptExtra += '\n\nCommunity findings to inform competitive analysis:\n' + evidence.communityContextText.substring(0, 2000);
  }
  const competitiveResult = await runCompetitiveResearch(insights, competitivePromptExtra).catch(error => {
    logger.warn('Competitive research failed, continuing without it', {
      jobId, error: error instanceof Error ? error.message : String(error),
    });
    return '';
  });
  emitPipelineStep(jobId, 'competitive-research', 'complete');

  // Step 3: Generate from YOUR narrative (PoV-first)
  emitPipelineStep(jobId, 'generate', 'running');
  updateJobProgress(jobId, { currentStep: 'Generating from product narrative...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      updateJobProgress(jobId, { currentStep: `Generating ${ASSET_TYPE_LABELS[assetType]} — ${voice.name}` });

      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');

      // Use PoV-first system prompt and user prompt when deep PoV is available
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = deepPoV
        ? buildSystemPrompt(voice, assetType, evidence.evidenceLevel, 'standard', bannedWords)
        : buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);

      let researchContext = competitiveResult;
      if (evidence.communityContextText) {
        researchContext = researchContext
          ? `${researchContext}\n\n${evidence.communityContextText}`
          : evidence.communityContextText;
      }

      const userPrompt = deepPoV
        ? buildPoVFirstPrompt(deepPoV, evidence.communityContextText, competitiveResult, template, assetType, existingMessaging, prompt)
        : buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);

      try {
        const initial = await generateAndScore(userPrompt, systemPrompt, selectedModel, scoringContext, thresholds, assetType);
        const result = await refinementLoop(initial.content, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt });
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

  emitPipelineStep(jobId, 'generate', 'complete');
  const researchLen = (competitiveResult?.length || 0) + (evidence.communityContextText?.length || 0);
  return finalizeJob(jobId, !!(competitiveResult || evidence.communityContextText), researchLen);
}

// ---------------------------------------------------------------------------
// Pipeline: Outside-In (practitioner pain first, layered enrichment)
// ---------------------------------------------------------------------------

async function runOutsideInPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Extract insights
  emitPipelineStep(jobId, 'extract-insights', 'running');
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'extract-insights', 'complete');

  // Pre-generate banned words for each voice
  const voiceBannedWords = new Map<string, string[]>();
  await Promise.all(selectedVoices.map(async (voice) => {
    voiceBannedWords.set(voice.id, await getBannedWordsForVoice(voice, insights));
  }));

  // Step 2: Community Deep Research — practitioner pain is the foundation
  emitPipelineStep(jobId, 'community-research', 'running');
  updateJobProgress(jobId, { currentStep: 'Running community Deep Research...', progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);
  emitPipelineStep(jobId, 'community-research', 'complete');

  // Outside-in pipeline requires community evidence — it's the whole point
  if (evidence.evidenceLevel === 'product-only') {
    logger.warn('Outside-in pipeline requires community evidence but none was found. Falling back to standard pipeline.', { jobId });
    updateJobProgress(jobId, { currentStep: 'No community evidence found — falling back to standard pipeline...' });
    return runStandardPipeline(jobId, inputs);
  }

  const practitionerContext = evidence.communityContextText;

  updateJobProgress(jobId, { currentStep: 'Generating pain-grounded drafts...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);

      try {
        // Step 3: Generate pain-grounded first draft
        emitPipelineStep(jobId, `pain-draft-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Generating pain-grounded draft — ${voice.name}` });

        const painFirstPrompt = buildPainFirstPrompt(practitionerContext, template, assetType, insights);
        const firstDraftResponse = await generateContent(painFirstPrompt, { systemPrompt, temperature: ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7 }, selectedModel);
        emitPipelineStep(jobId, `pain-draft-${assetType}-${voice.slug}`, 'complete', { draft: firstDraftResponse.text });

        // Step 4: Competitive research (with draft context for targeting)
        emitPipelineStep(jobId, `competitive-research-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Running competitive research — ${voice.name}` });

        const competitiveContext = await runCompetitiveResearch(insights, prompt).catch(() => '');
        emitPipelineStep(jobId, `competitive-research-${assetType}-${voice.slug}`, 'complete');

        // Step 5: Enrich draft with competitive intel
        emitPipelineStep(jobId, `enrich-competitive-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Enriching with competitive intel — ${voice.name}` });

        const enrichCompetitivePrompt = `Here's the practitioner-grounded draft. Here's competitive research. Update the draft to weave in competitive positioning WITHOUT losing the practitioner voice.

## Practitioner-Grounded Draft
${firstDraftResponse.text}

## Competitive Research
${competitiveContext.substring(0, 5000)}

## Rules
1. Keep the practitioner voice and pain-first structure
2. Add competitive differentiation where it strengthens the narrative
3. Don't add vendor-speak or marketing jargon
4. If the competitive research reveals gaps competitors miss, highlight those
5. Output ONLY the updated content`;

        const enrichedResponse = await generateContent(enrichCompetitivePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        emitPipelineStep(jobId, `enrich-competitive-${assetType}-${voice.slug}`, 'complete', { draft: enrichedResponse.text });

        // Step 6: Layer in product specifics
        emitPipelineStep(jobId, `layer-product-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Layering product specifics — ${voice.name}` });

        const productInsightsText = formatInsightsForPrompt(insights);
        const layerProductPrompt = `Here's the competitively-enriched draft. Here's detailed product intelligence. Add specific product capabilities, metrics, and claims where they strengthen the narrative. Don't vendor-speak it.

## Competitively-Enriched Draft
${enrichedResponse.text}

## Product Intelligence
${productInsightsText}

## Template / Format Guide
${template}

## Rules
1. Add specific product capabilities, metrics, and claims where they strengthen the narrative
2. Don't turn it into a feature list — weave product specifics in naturally
3. Keep the practitioner voice dominant
4. Every product mention should answer "so what?" for the practitioner
5. Output ONLY the final content`;

        const layeredResponse = await generateContent(layerProductPrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        emitPipelineStep(jobId, `layer-product-${assetType}-${voice.slug}`, 'complete', { draft: layeredResponse.text });

        // Step 7: Refinement loop
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Refining — ${voice.name}` });

        const result = await refinementLoop(layeredResponse.text, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'complete', { scores: result.scores });

        // Step 8: Store
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt: painFirstPrompt });
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
// Pipeline: Adversarial (generate, 2 rounds attack/defend, refinement loop)
// ---------------------------------------------------------------------------

async function runAdversarialPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Extract insights
  emitPipelineStep(jobId, 'extract-insights', 'running');
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'extract-insights', 'complete');

  // Pre-generate banned words for each voice
  const voiceBannedWords = new Map<string, string[]>();
  await Promise.all(selectedVoices.map(async (voice) => {
    voiceBannedWords.set(voice.id, await getBannedWordsForVoice(voice, insights));
  }));

  // Step 2: Community research first
  emitPipelineStep(jobId, 'community-research', 'running');
  updateJobProgress(jobId, { currentStep: 'Running community deep research...', progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);
  emitPipelineStep(jobId, 'community-research', 'complete');

  // Step 3: Competitive research informed by community findings
  emitPipelineStep(jobId, 'competitive-research', 'running');
  updateJobProgress(jobId, { currentStep: 'Running competitive research...', progress: 10 });
  let competitivePromptExtra = prompt || '';
  if (evidence.communityContextText) {
    competitivePromptExtra += '\n\nCommunity findings to inform competitive analysis:\n' + evidence.communityContextText.substring(0, 2000);
  }
  const competitiveResult = await runCompetitiveResearch(insights, competitivePromptExtra).catch(error => {
    logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
    return '';
  });
  emitPipelineStep(jobId, 'competitive-research', 'complete');

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
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);
      const userPrompt = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);
      const productInsightsText = formatInsightsForPrompt(insights);

      try {
        // Step 3: Generate initial draft
        emitPipelineStep(jobId, `draft-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Generating initial draft — ${voice.name}` });
        const initialResponse = await generateContent(userPrompt, { systemPrompt, temperature: ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7 }, selectedModel);
        let currentContent = initialResponse.text;
        emitPipelineStep(jobId, `draft-${assetType}-${voice.slug}`, 'complete', { draft: currentContent });

        // Two rounds of attack/defend
        for (let round = 1; round <= 2; round++) {
          // Attack
          emitPipelineStep(jobId, `attack-r${round}-${assetType}-${voice.slug}`, 'running');
          updateJobProgress(jobId, { currentStep: `Adversarial attack round ${round} — ${voice.name}` });

          const attackPrompt = `You are a hostile, skeptical senior practitioner reviewing vendor messaging. You've been burned by every vendor promise in the last decade. You hate buzzwords, vague claims, and anything that sounds like it was written by someone who has never done the actual work.

Tear apart this ${assetType.replace(/_/g, ' ')} messaging. Be ruthless but specific:

## Messaging to Attack
${currentContent}

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
          emitPipelineStep(jobId, `attack-r${round}-${assetType}-${voice.slug}`, 'complete');

          // Defend
          emitPipelineStep(jobId, `defend-r${round}-${assetType}-${voice.slug}`, 'running');
          updateJobProgress(jobId, { currentStep: `Defending round ${round} — ${voice.name}` });

          const defendPrompt = `Your ${assetType.replace(/_/g, ' ')} messaging was attacked by a skeptical practitioner. Rewrite it to survive every objection.

## Current Messaging
${currentContent}

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
          currentContent = defendedResponse.text;
          emitPipelineStep(jobId, `defend-r${round}-${assetType}-${voice.slug}`, 'complete', { draft: currentContent });
        }

        // Step 6: Refinement loop
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Refining — ${voice.name}` });
        const result = await refinementLoop(currentContent, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'complete', { scores: result.scores });

        // Step 7: Store
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt });
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
// Pipeline: Multi-Perspective (3 angles → synthesize → refinement loop)
// ---------------------------------------------------------------------------

async function runMultiPerspectivePipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Extract insights
  emitPipelineStep(jobId, 'extract-insights', 'running');
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'extract-insights', 'complete');

  // Pre-generate banned words for each voice
  const voiceBannedWords = new Map<string, string[]>();
  await Promise.all(selectedVoices.map(async (voice) => {
    voiceBannedWords.set(voice.id, await getBannedWordsForVoice(voice, insights));
  }));

  // Step 2: Community Deep Research + Competitive Research in parallel
  emitPipelineStep(jobId, 'research', 'running');
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
  emitPipelineStep(jobId, 'research', 'complete');

  updateJobProgress(jobId, { currentStep: 'Generating from multiple perspectives...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);

      try {
        // Step 3: Generate 3 perspectives in parallel
        const baseContext = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);

        const empathyAngle = `${baseContext}

## PERSPECTIVE: Practitioner Empathy
Lead ENTIRELY with pain. The reader should feel seen before they see any product mention. Use their language, their frustrations, their daily frustrations and hard-won lessons. Product comes last, almost as an afterthought. Make them nod before you pitch.`;

        const competitiveAngle = `${baseContext}

## PERSPECTIVE: Competitive Positioning
Lead with what current alternatives FAIL at. The reader should recognize the specific frustrations they have with their current tool. Then show what's different — not "better" (that's vendor-speak), but specifically what changes and why it matters for their workflow.`;

        const thoughtLeadershipAngle = `${baseContext}

## PERSPECTIVE: Thought Leadership
Lead with the industry's broken promise — the thing everyone was told would work but doesn't. Frame the problem as systemic, not just a tooling gap. Then present a different way of thinking about it. This should read like an opinionated blog post by someone who's seen the patterns across hundreds of teams.`;

        emitPipelineStep(jobId, `perspectives-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Generating 3 perspectives — ${voice.name}` });

        const perspectiveTemp = ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7;
        const [empathyRes, competitiveRes, thoughtRes] = await Promise.all([
          generateContent(empathyAngle, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
          generateContent(competitiveAngle, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
          generateContent(thoughtLeadershipAngle, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
        ]);
        emitPipelineStep(jobId, `perspectives-${assetType}-${voice.slug}`, 'complete');

        // Step 4: Synthesize best elements into one draft
        emitPipelineStep(jobId, `synthesize-${assetType}-${voice.slug}`, 'running');
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
        emitPipelineStep(jobId, `synthesize-${assetType}-${voice.slug}`, 'complete', { draft: synthesizedResponse.text });

        // Step 5: Refinement loop on the synthesized output
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Refining — ${voice.name}` });
        const result = await refinementLoop(synthesizedResponse.text, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'complete', { scores: result.scores });

        // Step 6: Store
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt: baseContext });
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
  wasDeslopped: boolean = false,
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
Every claim must pass the test: "Would a practitioner in this field share this with peers?"
Use the language of someone who does this work daily and is skeptical of vendor promises.
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


// ---------------------------------------------------------------------------
// PoV-First Prompt Builder — for Standard pipeline with deep PoV extraction
// ---------------------------------------------------------------------------

function buildPoVFirstPrompt(
  povInsights: DeepPoVInsights,
  communityContext: string,
  competitiveContext: string,
  template: string,
  assetType: AssetType,
  existingMessaging?: string,
  prompt?: string,
): string {
  let result = `## Our Point of View
${povInsights.pointOfView}

## Thesis
${povInsights.thesis}

## The Contrarian Take
${povInsights.contrarianTake}

## Narrative Arc
**Problem**: ${povInsights.narrativeArc.problem}
**Insight**: ${povInsights.narrativeArc.insight}
**Approach**: ${povInsights.narrativeArc.approach}
**Outcome**: ${povInsights.narrativeArc.outcome}

## Strongest Claims (with evidence)
${povInsights.strongestClaims.map(c => `- **${c.claim}**: ${c.evidence}`).join('\n')}

## Full Product Intelligence
${formatInsightsForPrompt(povInsights)}

## Community Validation
The following community evidence supports (or challenges) our narrative. Use it to strengthen claims, NOT to change the narrative:
${communityContext.substring(0, 4000)}

${competitiveContext ? `## Competitive Context\n${competitiveContext.substring(0, 4000)}` : ''}`;

  if (existingMessaging) {
    result += `\n\n## Existing Messaging (for reference/improvement)\n${existingMessaging.substring(0, 4000)}`;
  }

  if (prompt) {
    result += `\n\n## Focus / Instructions\n${prompt}`;
  }

  result += `\n\n## Template / Format Guide
${template}

## Instructions
Generate this ${assetType.replace(/_/g, ' ')} from OUR point of view. This is opinionated content — we have a specific narrative and thesis. The community evidence validates our claims; the competitive context sharpens our positioning. But the STORY is ours.

Lead with the thesis or contrarian take. Make the reader think "that's a bold but defensible position." Output ONLY the content.`;

  return result;
}

// ---------------------------------------------------------------------------
// Dynamic Banned Words — Flash call to generate voice+domain-specific banned words
// ---------------------------------------------------------------------------

const DEFAULT_BANNED_WORDS = [
  "industry-leading", "best-in-class", "next-generation", "enterprise-grade",
  "mission-critical", "turnkey", "end-to-end", "single pane of glass",
  "seamless", "robust", "leverage", "cutting-edge", "game-changer"
];

async function generateBannedWords(voice: any, insights: ExtractedInsights): Promise<string[]> {
  const prompt = `Given this voice profile and product domain, list 15-20 specific words and phrases that would sound inauthentic, vendor-heavy, or like AI-generated marketing copy to the target audience. Return ONLY a JSON array of strings.

Voice: ${voice.name} — ${voice.description}
${voice.voiceGuide ? `Voice Guide: ${voice.voiceGuide.substring(0, 500)}` : ''}
Domain: ${insights.domain} / ${insights.category}
Target personas: ${insights.targetPersonas.join(', ')}

Return ONLY a JSON array like: ["phrase1", "phrase2", ...]`;

  try {
    const response = await generateWithGemini(prompt, { model: config.ai.gemini.flashModel, temperature: 0.2, maxTokens: 1000 });
    const parsed = JSON.parse(response.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      logger.info('Generated dynamic banned words', { voice: voice.name, count: parsed.length });
      return parsed;
    }
    return DEFAULT_BANNED_WORDS;
  } catch (err) {
    logger.warn('Failed to generate dynamic banned words, using defaults', {
      voice: voice.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_BANNED_WORDS;
  }
}

// Cache: voiceId:domain -> banned words (per-process, cleared on restart)
const bannedWordsCache = new Map<string, string[]>();

export async function getBannedWordsForVoice(voice: any, insights: ExtractedInsights): Promise<string[]> {
  const cacheKey = `${voice.id}:${insights.domain || 'unknown'}`;
  if (bannedWordsCache.has(cacheKey)) return bannedWordsCache.get(cacheKey)!;
  const words = await generateBannedWords(voice, insights);
  bannedWordsCache.set(cacheKey, words);
  return words;
}

export function buildSystemPrompt(voice: any, assetType: AssetType, evidenceLevel?: EvidenceBundle['evidenceLevel'], pipeline?: 'standard' | 'outside-in', bannedWords?: string[]): string {
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

  const primaryDirective = pipeline === 'standard'
    ? `## Primary Directive
Lead with your point of view. The reader should encounter a clear, opinionated stance in the first two sentences.
This isn't neutral reporting — it's a well-supported argument. Back every claim with evidence from the product docs.
Open with the thesis or contrarian take. Make the reader think "that's a bold but defensible position."
Then build the argument with evidence and narrative arc.`
    : `## Primary Directive
Lead with the pain. The reader should recognize their frustration in the first two sentences.
Do not open with what the product does. Open with what's broken, what hurts, what the reader is struggling with today.
Then — and only then — show how things change.`;

  return `You are a messaging strategist generating ${assetType.replace(/_/g, ' ')} content.

${primaryDirective}

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
8. DO NOT use: ${(bannedWords ?? DEFAULT_BANNED_WORDS).map(w => `"${w}"`).join(", ")}

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
