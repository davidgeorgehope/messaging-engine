import type { VoiceProfile, SessionVersion, Session, ScoringThresholds } from '../../types/index.js';
import { parseScoringThresholds } from '../../types/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { sessions, sessionVersions, voiceProfiles, productDocuments, generationJobs } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { analyzeSlop, deslop } from '../../services/quality/slop-detector.js';
import { scoreContent, checkQualityGates, totalQualityScore } from '../quality/score-content.js';
import { generateWithGemini, generateWithGeminiGroundedSearch, createDeepResearchInteraction, pollInteractionUntilComplete } from '../ai/clients.js';
import { config, getModelForTask } from '../../config.js';
import type { ScoreResults } from '../quality/score-content.js';
import type { AssetType } from '../../services/generation/types.js';
import {
  extractInsights,
  buildFallbackInsights,
  formatInsightsForDiscovery,
  formatInsightsForResearch,
  formatInsightsForPrompt,
  formatInsightsForScoring,
} from '../product/insights.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildRefinementPrompt,
  loadTemplate,
  generateContent,
  ASSET_TYPE_TEMPERATURE,
  getBannedWordsForVoice,
} from '../../api/generate.js';

const logger = createLogger('workspace:actions');

export interface ActionResult {
  version: SessionVersion | null | undefined;
  previousScores: {
    slop: number | null;
    vendorSpeak: number | null;
    authenticity: number | null;
    specificity: number | null;
    persona: number | null;
    passesGates: boolean;
  } | null;
}

function extractPreviousScores(active: SessionVersion | null | undefined): ActionResult['previousScores'] {
  if (!active || active.slopScore === null) return null;
  return {
    slop: active.slopScore,
    vendorSpeak: active.vendorSpeakScore,
    authenticity: active.authenticityScore,
    specificity: active.specificityScore,
    persona: active.personaAvgScore,
    passesGates: !!active.passesGates,
  };
}

async function getActiveVersion(sessionId: string, assetType: string) {
  const db = getDatabase();
  const versions = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
    ),
    orderBy: [desc(sessionVersions.versionNumber)],
  });
  return versions.find(v => v.isActive) || versions[0];
}

async function getNextVersionNumber(sessionId: string, assetType: string): Promise<number> {
  const db = getDatabase();
  const existing = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
    ),
    orderBy: [desc(sessionVersions.versionNumber)],
    limit: 1,
  });
  return (existing[0]?.versionNumber ?? 0) + 1;
}

async function createVersionAndActivate(
  sessionId: string,
  assetType: string,
  content: string,
  source: string,
  sourceDetail: Record<string, unknown>,
  scores?: ScoreResults,
  thresholds?: ScoringThresholds,
) {
  const db = getDatabase();
  const versionNumber = await getNextVersionNumber(sessionId, assetType);

  // Deactivate current active versions
  const activeVersions = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
      eq(sessionVersions.isActive, true),
    ),
  });
  for (const v of activeVersions) {
    await db.update(sessionVersions).set({ isActive: false }).where(eq(sessionVersions.id, v.id)).run();
  }

  const passesGates = scores && thresholds ? checkQualityGates(scores, thresholds) : false;
  const versionId = generateId();

  await db.insert(sessionVersions).values({
    id: versionId,
    sessionId,
    assetType,
    versionNumber,
    content,
    source,
    sourceDetail: JSON.stringify(sourceDetail),
    slopScore: scores?.slopScore ?? null,
    vendorSpeakScore: scores?.vendorSpeakScore ?? null,
    authenticityScore: scores?.authenticityScore ?? null,
    specificityScore: scores?.specificityScore ?? null,
    personaAvgScore: scores?.personaAvgScore ?? null,
    passesGates,
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  return db.query.sessionVersions.findFirst({ where: eq(sessionVersions.id, versionId) });
}

async function loadSessionThresholds(sessionId: string) {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session?.voiceProfileId) {
    return { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6 };
  }
  const voice = await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.id, session.voiceProfileId) });
  if (!voice) return { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6 };
  return parseScoringThresholds(voice.scoringThresholds);
}

async function loadSessionProductDocs(session: Session): Promise<string> {
  const db = getDatabase();
  let productContext = session.productContext || '';
  const docIds = session.productDocIds ? JSON.parse(session.productDocIds) : [];
  if (docIds.length > 0) {
    const docs = await Promise.all(
      docIds.map((id: string) => db.query.productDocuments.findFirst({ where: eq(productDocuments.id, id) }))
    );
    const docsText = docs.filter(Boolean).map((d: { name: string; content: string | null }) => `## ${d.name}\n${d.content}`).join('\n\n');
    productContext = docsText + (productContext ? `\n\n${productContext}` : '');
  }
  return productContext;
}


function buildCompetitiveResearchPrompt(researchContext: string, currentContent: string, assetType: string): string {
  return `Analyze the product context below and identify the 3-5 most direct competitors. Then research each competitor in depth.

## Step 1: Identify Competitors
From the product context, infer the most direct competitors based on the product category, target audience, and capabilities described.

## Step 2: For Each Competitor, Research
- Specific product limitations (include version numbers where available)
- Recent pricing or packaging changes (include dates)
- Migration complaints from practitioners in community forums
- Claims that contradict our product's positioning

## Step 3: Label Each Finding
Tag every finding with its evidence type:
- [official docs] — from vendor documentation or changelogs
- [community sentiment] — from forums, Reddit, HN, Stack Overflow
- [analyst coverage] — from analyst reports, reviews, benchmarks

## Product Context
${researchContext}

## Current ${assetType.replace(/_/g, ' ')} Content
${currentContent.substring(0, 3000)}

Provide detailed findings with specific examples and source URLs.`;
}

function buildCompetitiveEnrichmentPrompt(currentContent: string, researchContext: string, assetType: string): string {
  const internalTypes = ['battlecard', 'talk_track'];
  const competitorInstruction = internalTypes.includes(assetType)
    ? 'Name competitors explicitly with specific differentiators'
    : 'Reference competitive gaps without naming competitors directly';

  return `Enrich this ${assetType.replace(/_/g, ' ')} with competitive intelligence.

## Current Content
${currentContent.substring(0, 8000)}

## Competitive Research
${researchContext.substring(0, 6000)}

Rewrite the content to:
1. Sharpen competitive differentiation where research reveals gaps
2. ${competitorInstruction}
3. Strengthen claims with market evidence
4. Keep the same structure and format
5. Maintain practitioner-first voice — no vendor speak

Output ONLY the enriched content.`;
}


/**
 * Run deslop on the active version of an asset type.
 */
export async function runDeslopAction(sessionId: string, assetType: string): Promise<ActionResult> {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version to deslop');

  const previousScores = extractPreviousScores(active);
  logger.info('Running deslop action', { sessionId, assetType });

  const slopAnalysis = await analyzeSlop(active.content);
  const deslopped = await deslop(active.content, slopAnalysis);
  const scores = await scoreContent(deslopped);
  const thresholds = await loadSessionThresholds(sessionId);

  const version = await createVersionAndActivate(sessionId, assetType, deslopped, 'deslop', {
    previousVersion: active.versionNumber,
    slopAnalysis,
  }, scores, thresholds);
  return { version, previousScores };
}

/**
 * Regenerate an asset type from scratch using the full generation context —
 * voice profile, template, competitive research, evidence grounding, and
 * refinement loop — matching the quality of the original generation pipeline.
 */
export async function runRegenerateAction(sessionId: string, assetType: string): Promise<ActionResult> {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  logger.info('Running regenerate action', { sessionId, assetType });

  // Load voice profile (same as original generation)
  const voice = session.voiceProfileId
    ? await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.id, session.voiceProfileId) })
    : await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.isDefault, true) });
  if (!voice) throw new Error('No voice profile available');

  const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');

  // Extract product insights
  const productDocs = await loadSessionProductDocs(session);
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const scoringContext = formatInsightsForScoring(insights);

  // Load competitive research from the original generation job (if available)
  let researchContext = '';
  if (session.jobId) {
    const job = await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, session.jobId) });
    if (job?.competitiveResearch) {
      try {
        researchContext = typeof job.competitiveResearch === 'string'
          ? job.competitiveResearch
          : JSON.stringify(job.competitiveResearch);
      } catch { /* ignore parse errors */ }
    }
  }

  // Get existing content as reference for the regeneration
  const active = await getActiveVersion(sessionId, assetType);
  const previousScores = extractPreviousScores(active);
  const existingMessaging = active?.content;

  // Determine evidence level — regeneration uses product-only since we don't re-run
  // community Deep Research (that's what the community_check action is for)
  const evidenceLevel: 'strong' | 'partial' | 'product-only' = researchContext ? 'partial' : 'product-only';

  // Generate dynamic banned words for this voice + domain
  const bannedWords = await getBannedWordsForVoice(voice, insights);

  // Load the asset type template
  const template = loadTemplate(assetType as AssetType);

  // Build full prompts — identical to the original generation pipeline
  const systemPrompt = buildSystemPrompt(voice, assetType as AssetType, evidenceLevel, undefined, bannedWords);
  const userPrompt = buildUserPrompt(
    existingMessaging,
    session.focusInstructions ?? undefined,
    researchContext,
    template,
    assetType as AssetType,
    insights,
    evidenceLevel,
  );

  // Generate with the same model dispatch as the original pipeline
  const selectedModel = JSON.parse(session.metadata || '{}').model;
  const response = await generateContent(userPrompt, {
    systemPrompt,
    temperature: ASSET_TYPE_TEMPERATURE[assetType as AssetType] ?? 0.7,
  }, selectedModel);

  let finalContent = response.text;
  let scores = await scoreContent(finalContent, [scoringContext]);
  let passesGates = checkQualityGates(scores, thresholds);

  // Refinement loop — deslop + refine if quality gates fail (matches original pipeline)
  if (!passesGates) {
    logger.info('Regenerated content failed gates, attempting refinement', {
      sessionId, assetType, slop: scores.slopScore, vendor: scores.vendorSpeakScore,
      auth: scores.authenticityScore, spec: scores.specificityScore, persona: scores.personaAvgScore,
    });

    if (scores.slopScore > thresholds.slopMax) {
      try {
        finalContent = await deslop(finalContent, scores.slopAnalysis);
      } catch (deslopErr) {
        logger.warn('Deslop failed during regeneration, continuing with original', {
          error: deslopErr instanceof Error ? deslopErr.message : String(deslopErr),
        });
      }
    }

    const refinementPrompt = buildRefinementPrompt(finalContent, scores, thresholds, voice, assetType as AssetType);
    try {
      const refinedResponse = await generateContent(refinementPrompt, {
        systemPrompt,
        temperature: 0.5,
      }, selectedModel);

      const refinedScores = await scoreContent(refinedResponse.text, [scoringContext]);
      if (totalQualityScore(refinedScores) > totalQualityScore(scores)) {
        finalContent = refinedResponse.text;
        scores = refinedScores;
        passesGates = checkQualityGates(scores, thresholds);
      }
    } catch (refineErr) {
      logger.warn('Refinement failed during regeneration, keeping original', {
        error: refineErr instanceof Error ? refineErr.message : String(refineErr),
      });
    }
  }

  const version = await createVersionAndActivate(sessionId, assetType, finalContent, 'regenerate', {
    regeneratedAt: new Date().toISOString(),
    voiceProfileId: voice.id,
    voiceName: voice.name,
    evidenceLevel,
    refined: !passesGates ? false : undefined,
  }, scores, thresholds);
  return { version, previousScores };
}

/**
 * Regenerate with a different voice profile.
 */
export async function runVoiceChangeAction(sessionId: string, assetType: string, newVoiceProfileId: string): Promise<ActionResult> {
  const db = getDatabase();
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version');
  const previousScores = extractPreviousScores(active);

  const voice = await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.id, newVoiceProfileId) });
  if (!voice) throw new Error('Voice profile not found');

  logger.info('Running voice change action', { sessionId, assetType, newVoiceProfileId });

  const prompt = `Rewrite the following ${assetType.replace(/_/g, ' ')} content using this voice profile:\n\n## Voice: ${voice.name}\n${voice.voiceGuide}\n\n## Content to Rewrite\n${active.content}\n\nRewrite in the new voice. Output ONLY the rewritten content.`;

  const response = await generateWithGemini(prompt, {
    model: getModelForTask('pro'),
    temperature: 0.5,
  });

  const scores = await scoreContent(response.text);
  const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');

  const version = await createVersionAndActivate(sessionId, assetType, response.text, 'voice_change', {
    previousVoice: active.source,
    newVoiceId: newVoiceProfileId,
    newVoiceName: voice.name,
  }, scores, thresholds);
  return { version, previousScores };
}

/**
 * Run adversarial loop: always attempt improvement (min 1, max 3 iterations).
 * If content already passes gates, switches to "elevation" mode to raise scores higher.
 * Only creates a new version if content actually changed.
 */
export async function runAdversarialLoopAction(sessionId: string, assetType: string): Promise<ActionResult> {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version');
  const previousScores = extractPreviousScores(active);

  const thresholds = await loadSessionThresholds(sessionId);
  const originalContent = active.content;
  let content = active.content;
  let scores = await scoreContent(content);
  let bestScore = totalQualityScore(scores);
  const maxIterations = 3;
  let wasDeslopped = false;

  logger.info('Running adversarial loop', { sessionId, assetType, alreadyPassing: checkQualityGates(scores, thresholds) });

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Deslop if slop is high
    if (scores.slopScore > (thresholds.slopMax ?? 5)) {
      try {
        content = await deslop(content, scores.slopAnalysis);
        wasDeslopped = true;
      } catch { /* continue */ }
    }

    // Build issues list — when already passing gates, target any score below perfect
    const issues: string[] = [];
    const alreadyPassing = checkQualityGates(scores, thresholds);

    if (alreadyPassing) {
      // Elevation mode: push scores higher even though they pass
      if (scores.slopScore > 2) issues.push(`Slop score is ${scores.slopScore.toFixed(1)} — reduce AI clichés and filler further.`);
      if (scores.vendorSpeakScore > 2) issues.push(`Vendor-speak score is ${scores.vendorSpeakScore.toFixed(1)} — make it sound even more like a practitioner wrote it.`);
      if (scores.authenticityScore < 9) issues.push(`Authenticity is ${scores.authenticityScore.toFixed(1)} — make it sound more genuinely human.`);
      if (scores.specificityScore < 9) issues.push(`Specificity is ${scores.specificityScore.toFixed(1)} — add more concrete details, numbers, or examples.`);
      if (scores.personaAvgScore < 9) issues.push(`Persona fit is ${scores.personaAvgScore.toFixed(1)} — better match the target audience's concerns and language.`);
    } else {
      // Fix mode: target scores that fail thresholds
      if (scores.vendorSpeakScore > (thresholds.vendorSpeakMax ?? 5)) {
        issues.push(`Vendor-speak score ${scores.vendorSpeakScore.toFixed(1)} exceeds max ${thresholds.vendorSpeakMax}. Replace vendor language with practitioner language.`);
      }
      if (scores.authenticityScore < (thresholds.authenticityMin ?? 6)) {
        issues.push(`Authenticity score ${scores.authenticityScore.toFixed(1)} below min ${thresholds.authenticityMin}. Make it sound more human.`);
      }
      if (scores.specificityScore < (thresholds.specificityMin ?? 6)) {
        issues.push(`Specificity score ${scores.specificityScore.toFixed(1)} below min ${thresholds.specificityMin}. Add concrete details.`);
      }
      if (scores.personaAvgScore < (thresholds.personaMin ?? 6)) {
        issues.push(`Persona fit score ${scores.personaAvgScore.toFixed(1)} below min ${thresholds.personaMin}. Better match the target audience.`);
      }
    }

    if (issues.length === 0) break;

    const modeLabel = alreadyPassing ? 'Elevate' : 'Fix';
    const refinementPrompt = `${modeLabel} these quality issues in this ${assetType.replace(/_/g, ' ')}:\n${issues.map(i => `- ${i}`).join('\n')}\n\n## Content\n${content}\n\nOutput ONLY the improved content. Keep the same structure and format.`;
    try {
      const response = await generateWithGemini(refinementPrompt, {
        model: getModelForTask('pro'),
        temperature: 0.4,
      });
      content = response.text;
    } catch { break; }

    scores = await scoreContent(content);
    const newScore = totalQualityScore(scores);

    // Stop if quality didn't improve
    if (newScore <= bestScore) {
      logger.info('Adversarial loop: no improvement, stopping', { iteration, bestScore, newScore });
      break;
    }
    bestScore = newScore;
  }

  // Only create a new version if content actually changed
  if (content.trim() === originalContent.trim()) {
    return { version: null, previousScores };
  }

  const version = await createVersionAndActivate(sessionId, assetType, content, 'adversarial', {
    finalScores: scores,
  }, scores, thresholds);
  return { version, previousScores };
}

export async function runCompetitiveDeepDiveAction(sessionId: string, assetType: string): Promise<ActionResult> {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version for competitive dive');
  const previousScores = extractPreviousScores(active);

  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  logger.info('Running competitive deep dive action', { sessionId, assetType });

  const productDocs = await loadSessionProductDocs(session);
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const researchInsights = formatInsightsForResearch(insights);

  // Build research prompt
  const researchPrompt = buildCompetitiveResearchPrompt(researchInsights, active.content, assetType);

  // Try deep research first, fall back to grounded search
  let researchContext: string;
  try {
    const interactionId = await createDeepResearchInteraction(researchPrompt);
    const result = await pollInteractionUntilComplete(interactionId);
    researchContext = result.text;
    if (result.sources.length > 0) {
      researchContext += '\n\nSources:\n' + result.sources.map(s => `- ${s.title}: ${s.url}`).join('\n');
    }
  } catch (err) {
    logger.warn('Deep research failed, falling back to grounded search', { error: String(err) });
    const groundedResult = await generateWithGeminiGroundedSearch(researchPrompt);
    researchContext = groundedResult.text;
    if (groundedResult.sources.length > 0) {
      researchContext += '\n\nSources:\n' + groundedResult.sources.map(s => `- ${s.title}: ${s.url}`).join('\n');
    }
  }

  // Enrich with Gemini Pro
  const enrichmentPrompt = buildCompetitiveEnrichmentPrompt(active.content, researchContext, assetType);
  const enriched = await generateWithGemini(enrichmentPrompt, {
    model: getModelForTask('pro'),
    temperature: 0.5,
  });

  const scores = await scoreContent(enriched.text);
  const thresholds = await loadSessionThresholds(sessionId);

  const version = await createVersionAndActivate(sessionId, assetType, enriched.text, 'competitive_dive', {
    researchLength: researchContext.length,
    enrichedAt: new Date().toISOString(),
  }, scores, thresholds);
  return { version, previousScores };
}

export async function runCommunityCheckAction(sessionId: string, assetType: string): Promise<ActionResult> {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version for community check');
  const previousScores = extractPreviousScores(active);

  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  logger.info('Running community check action', { sessionId, assetType });

  const productDocs = await loadSessionProductDocs(session);
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const discoveryContext = formatInsightsForDiscovery(insights);

  // Single Deep Research call replaces all individual source adapters
  const deepResearchPrompt = `Search Reddit, Hacker News, Stack Overflow, GitHub Issues, developer blogs, and other practitioner communities for real discussions, complaints, and pain points related to this product area.

## Product Area
${discoveryContext}

## What to Find
1. Real practitioner quotes expressing frustration with current tools in this space
2. Common complaints and pain points from community discussions
3. What practitioners wish existed or worked better
4. The language practitioners actually use to describe these problems

## Output Format
Organize findings as:
- **Practitioner Quotes**: Verbatim quotes from real community posts (include source URL)
- **Common Pain Points**: Recurring themes across communities
- **Language Patterns**: The specific words and phrases practitioners use

Be specific. Include actual quotes with source URLs.`;

  const interactionId = await createDeepResearchInteraction(deepResearchPrompt);
  const result = await pollInteractionUntilComplete(interactionId);

  if (!result.text || result.text.length < 100) {
    throw new Error('Community Deep Research returned insufficient results');
  }

  let communityContext = '## Community Evidence (from Deep Research)\n\n' + result.text;
  if (result.sources.length > 0) {
    communityContext += '\n\nSources:\n' + result.sources.map(s => `- [${s.title}](${s.url})`).join('\n');
  }

  const rewritePrompt = `Rewrite this ${assetType.replace(/_/g, ' ')} using real community evidence.

## Current Content
${active.content.substring(0, 8000)}

## Community Evidence
${communityContext.substring(0, 8000)}

Rewrite the content to:
1. Ground claims in specific community discussions
2. Use language patterns that match how practitioners actually talk
3. Reference specific pain points raised in the community
4. Make the content feel written by someone who's been in the trenches
5. Keep the same structure and format
6. Do not introduce claims that aren't supported by the community evidence provided. Preserve factual accuracy from the original content.

Output ONLY the rewritten content.`;

  const rewritten = await generateWithGemini(rewritePrompt, {
    model: getModelForTask('pro'),
    temperature: 0.5,
  });

  const scores = await scoreContent(rewritten.text);
  const thresholds = await loadSessionThresholds(sessionId);

  const version = await createVersionAndActivate(sessionId, assetType, rewritten.text, 'community_check', {
    sourceCount: result.sources.length,
    enrichedAt: new Date().toISOString(),
  }, scores, thresholds);
  return { version, previousScores };
}

/**
 * Run multi-perspective rewrite: generate 3 angles (empathy, competitive, thought leadership)
 * from the active version, synthesize the best elements, score all 4, keep the best.
 */
export async function runMultiPerspectiveAction(sessionId: string, assetType: string): Promise<ActionResult> {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version for multi-perspective');
  const previousScores = extractPreviousScores(active);

  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  logger.info('Running multi-perspective action', { sessionId, assetType });

  // Load voice profile
  const voice = session.voiceProfileId
    ? await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.id, session.voiceProfileId) })
    : await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.isDefault, true) });
  if (!voice) throw new Error('No voice profile available');

  const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
  const productDocs = await loadSessionProductDocs(session);
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const scoringContext = formatInsightsForScoring(insights);
  const template = loadTemplate(assetType as AssetType);
  const bannedWords = await getBannedWordsForVoice(voice, insights);
  const systemPrompt = buildSystemPrompt(voice, assetType as AssetType, undefined, undefined, bannedWords);
  const selectedModel = JSON.parse(session.metadata || '{}').model;

  const baseContent = active.content;

  // Generate 3 perspectives in parallel using existing content as base
  const empathyPrompt = `Rewrite this ${assetType.replace(/_/g, ' ')} from a Practitioner Empathy perspective.

## Current Content
${baseContent}

## PERSPECTIVE: Practitioner Empathy
Lead ENTIRELY with pain. The reader should feel seen before they see any product mention. Use their language, their frustrations, their daily frustrations and hard-won lessons. Product comes last, almost as an afterthought. Make them nod before you pitch.

## Format Guide
${template}

Output ONLY the rewritten content.`;

  const competitivePrompt = `Rewrite this ${assetType.replace(/_/g, ' ')} from a Competitive Positioning perspective.

## Current Content
${baseContent}

## PERSPECTIVE: Competitive Positioning
Lead with what current alternatives FAIL at. The reader should recognize the specific frustrations they have with their current tool. Then show what's different — not "better" (that's vendor-speak), but specifically what changes and why it matters for their workflow.

## Format Guide
${template}

Output ONLY the rewritten content.`;

  const thoughtPrompt = `Rewrite this ${assetType.replace(/_/g, ' ')} from a Thought Leadership perspective.

## Current Content
${baseContent}

## PERSPECTIVE: Thought Leadership
Lead with the industry's broken promise — the thing everyone was told would work but doesn't. Frame the problem as systemic, not just a tooling gap. Then present a different way of thinking about it. This should read like an opinionated blog post by someone who's seen the patterns across hundreds of teams.

## Format Guide
${template}

Output ONLY the rewritten content.`;

  const perspectiveTemp = ASSET_TYPE_TEMPERATURE[assetType as AssetType] ?? 0.7;
  const [empathyRes, competitiveRes, thoughtRes] = await Promise.all([
    generateContent(empathyPrompt, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
    generateContent(competitivePrompt, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
    generateContent(thoughtPrompt, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
  ]);

  // Synthesize the best elements
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

  const synthesizedRes = await generateContent(synthesizePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);

  // Score all 4, keep the best
  const [empathyScores, competitiveScores, thoughtScores, synthesizedScores] = await Promise.all([
    scoreContent(empathyRes.text, [scoringContext]),
    scoreContent(competitiveRes.text, [scoringContext]),
    scoreContent(thoughtRes.text, [scoringContext]),
    scoreContent(synthesizedRes.text, [scoringContext]),
  ]);

  const candidates = [
    { content: empathyRes.text, scores: empathyScores, label: 'empathy' },
    { content: competitiveRes.text, scores: competitiveScores, label: 'competitive' },
    { content: thoughtRes.text, scores: thoughtScores, label: 'thought_leadership' },
    { content: synthesizedRes.text, scores: synthesizedScores, label: 'synthesized' },
  ];

  const best = candidates.reduce((a, b) =>
    totalQualityScore(b.scores) > totalQualityScore(a.scores) ? b : a
  );

  const version = await createVersionAndActivate(sessionId, assetType, best.content, 'multi_perspective', {
    winningPerspective: best.label,
    allScores: candidates.map(c => ({ label: c.label, total: totalQualityScore(c.scores).toFixed(1) })),
  }, best.scores, thresholds);
  return { version, previousScores };
}
