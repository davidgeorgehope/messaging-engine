import { eq, and, desc } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { sessions, sessionVersions, voiceProfiles, productDocuments, discoveredPainPoints } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { analyzeSlop, deslop } from '../../services/quality/slop-detector.js';
import { scoreContent, checkQualityGates } from '../quality/score-content.js';
import { generateWithGemini, generateWithGeminiGroundedSearch, createDeepResearchInteraction, pollInteractionUntilComplete } from '../ai/clients.js';
import { config } from '../../config.js';
import { discoverFromReddit } from '../discovery/sources/reddit.js';
import { discoverFromHackerNews } from '../discovery/sources/hackernews.js';
import { discoverFromStackOverflow } from '../discovery/sources/stackoverflow.js';
import { discoverFromGitHub } from '../discovery/sources/github.js';
import { discoverFromDiscourse, inferDiscourseForums } from '../discovery/sources/discourse.js';
import { discoverFromGroundedSearch } from '../discovery/sources/grounded-search.js';
import type { ScoreResults } from '../quality/score-content.js';
import type { AssetType } from '../../services/generation/types.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../discovery/types.js';
import {
  extractInsights,
  buildFallbackInsights,
  formatInsightsForDiscovery,
  formatInsightsForResearch,
  formatInsightsForPrompt,
  formatInsightsForScoring,
} from '../product/insights.js';

const logger = createLogger('workspace:actions');

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
  sourceDetail: any,
  scores?: ScoreResults,
  thresholds?: any,
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
  return JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');
}

async function loadSessionProductDocs(session: any): Promise<string> {
  const db = getDatabase();
  let productContext = session.productContext || '';
  const docIds = session.productDocIds ? JSON.parse(session.productDocIds) : [];
  if (docIds.length > 0) {
    const docs = await Promise.all(
      docIds.map((id: string) => db.query.productDocuments.findFirst({ where: eq(productDocuments.id, id) }))
    );
    const docsText = docs.filter(Boolean).map((d: any) => `## ${d.name}\n${d.content}`).join('\n\n');
    productContext = docsText + (productContext ? `\n\n${productContext}` : '');
  }
  return productContext;
}

// ---------------------------------------------------------------------------
// AI-powered keyword extraction + source inference
// ---------------------------------------------------------------------------

export interface DiscoveryInference {
  keywords: string[];
  subreddits: string[];
  stackOverflowTags: string[];
  githubRepos: string[];
  discourseForums: Array<{ host: string; name: string }>;
}

/**
 * Use Gemini Flash to extract search keywords AND infer relevant community sources
 * in a single LLM call. No naive fallback — if the LLM can't understand the product
 * docs well enough to extract keywords, the pipeline should not proceed with garbage.
 * Grounded search (LLM + Google Search) is the guaranteed safety net downstream.
 *
 * @param productContext Pre-formatted product context (discovery-level or raw docs for workspace actions)
 */
export async function extractKeywordsAndSources(
  session: any,
  painPoint: any,
  productContext: string,
): Promise<DiscoveryInference> {
  const context = [
    painPoint?.title || '',
    painPoint?.content || '',
    session.manualPainPoint || '',
    productContext,
  ].filter(Boolean).join('\n\n');

  if (!context.trim()) {
    throw new Error('No product context provided — cannot extract keywords');
  }

  const prompt = `Analyze this product/pain context and extract search terms and community sources where practitioners discuss these problems.

## Context
${context}

Return a JSON object with:
- "keywords": 5-8 search phrases a practitioner would use when complaining about the problems this product solves. Focus on pain terms (e.g. "alert fatigue", "SOAR sprawl", "too many dashboards"), tool categories, and community jargon. Multi-word phrases are better than single words.
- "subreddits": 3-6 relevant subreddit names (without r/) where practitioners discuss these topics
- "stackOverflowTags": 3-5 Stack Overflow tags relevant to this domain
- "githubRepos": 2-4 GitHub repos (owner/repo format) for major open-source tools in this space that would have relevant issues
- "discourseForums": 2-4 Discourse forums as objects with "host" (domain) and "name" fields, e.g. {"host": "discuss.kubernetes.io", "name": "Kubernetes Forum"}

IMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`;

  const response = await generateWithGemini(prompt, {
    temperature: 0.3,
    maxTokens: 2000,
  });

  let jsonText = response.text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  const parsed = JSON.parse(jsonText);

  const result: DiscoveryInference = {
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 8) : [],
    subreddits: Array.isArray(parsed.subreddits) ? parsed.subreddits.slice(0, 6) : [],
    stackOverflowTags: Array.isArray(parsed.stackOverflowTags) ? parsed.stackOverflowTags.slice(0, 5) : [],
    githubRepos: Array.isArray(parsed.githubRepos) ? parsed.githubRepos.slice(0, 4) : [],
    discourseForums: Array.isArray(parsed.discourseForums) ? parsed.discourseForums.slice(0, 4) : [],
  };

  if (result.keywords.length === 0) {
    throw new Error('AI keyword extraction returned no keywords from the provided context');
  }

  logger.info('AI keyword/source extraction complete', {
    keywords: result.keywords,
    subreddits: result.subreddits,
    soTags: result.stackOverflowTags,
    repos: result.githubRepos,
    forums: result.discourseForums.length,
  });

  return result;
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

export function engagementScore(post: RawDiscoveredPainPoint): number {
  const m = post.metadata;
  switch (post.sourceType) {
    case 'reddit':
      return (m.score as number || 0) + (m.numComments as number || 0) * 2;
    case 'hackernews':
      return (m.points as number || 0);
    case 'github':
      return (m.reactions as number || 0) * 3;
    case 'discourse':
      return (m.topicViews as number || 0) / 20 + (m.topicLikes as number || 0) * 2 + (m.topicReplies as number || 0) * 2 + (m.postLikes as number || 0) * 3;
    case 'stackoverflow':
      return (m.score as number || 0) + (m.viewCount as number || 0) / 50;
    default:
      return 0;
  }
}

function buildCommunityContext(posts: RawDiscoveredPainPoint[], groundedContext: string): string {
  // Sort by source-normalized engagement score
  const sorted = [...posts].sort((a, b) => engagementScore(b) - engagementScore(a));

  const topPosts = sorted.slice(0, 30);
  let context = '## Community Discussions\n\n';

  for (const post of topPosts) {
    context += `### [${post.sourceType}] ${post.title}\n`;
    context += `Source: ${post.sourceUrl}\n`;
    context += `Author: ${post.author}\n`;
    context += `${post.content.substring(0, 500)}\n\n`;
  }

  if (groundedContext) {
    context += `\n## Supplemental Web Research\n${groundedContext.substring(0, 3000)}\n`;
  }

  return context;
}

function buildCommunityRewritePrompt(currentContent: string, communityContext: string, assetType: string): string {
  return `Rewrite this ${assetType.replace(/_/g, ' ')} using real community evidence.

## Current Content
${currentContent.substring(0, 8000)}

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
}

/**
 * Run deslop on the active version of an asset type.
 */
export async function runDeslopAction(sessionId: string, assetType: string) {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version to deslop');

  logger.info('Running deslop action', { sessionId, assetType });

  const slopAnalysis = await analyzeSlop(active.content);
  const deslopped = await deslop(active.content, slopAnalysis);
  const scores = await scoreContent(deslopped);
  const thresholds = await loadSessionThresholds(sessionId);

  return createVersionAndActivate(sessionId, assetType, deslopped, 'deslop', {
    previousVersion: active.versionNumber,
    slopAnalysis,
  }, scores, thresholds);
}

/**
 * Regenerate an asset type from scratch using the existing session context.
 */
export async function runRegenerateAction(sessionId: string, assetType: string) {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  logger.info('Running regenerate action', { sessionId, assetType });

  const productDocs = await loadSessionProductDocs(session);
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const insightsText = formatInsightsForPrompt(insights);

  const prompt = `Regenerate ${assetType.replace(/_/g, ' ')} content. Focus on practitioner pain, be specific, avoid vendor-speak.\n\n${insightsText}`;

  const response = await generateWithGemini(prompt, {
    model: config.ai.gemini.proModel,
    temperature: 0.7,
    maxTokens: 8000,
  });

  const scoringContext = formatInsightsForScoring(insights);
  const scores = await scoreContent(response.text, [scoringContext]);
  const thresholds = await loadSessionThresholds(sessionId);

  return createVersionAndActivate(sessionId, assetType, response.text, 'regenerate', {
    regeneratedAt: new Date().toISOString(),
  }, scores, thresholds);
}

/**
 * Regenerate with a different voice profile.
 */
export async function runVoiceChangeAction(sessionId: string, assetType: string, newVoiceProfileId: string) {
  const db = getDatabase();
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version');

  const voice = await db.query.voiceProfiles.findFirst({ where: eq(voiceProfiles.id, newVoiceProfileId) });
  if (!voice) throw new Error('Voice profile not found');

  logger.info('Running voice change action', { sessionId, assetType, newVoiceProfileId });

  const prompt = `Rewrite the following ${assetType.replace(/_/g, ' ')} content using this voice profile:\n\n## Voice: ${voice.name}\n${voice.voiceGuide}\n\n## Content to Rewrite\n${active.content}\n\nRewrite in the new voice. Output ONLY the rewritten content.`;

  const response = await generateWithGemini(prompt, {
    model: config.ai.gemini.proModel,
    temperature: 0.5,
    maxTokens: 8000,
  });

  const scores = await scoreContent(response.text);
  const thresholds = JSON.parse(voice.scoringThresholds || '{"slopMax":5,"vendorSpeakMax":5,"authenticityMin":6,"specificityMin":6,"personaMin":6}');

  return createVersionAndActivate(sessionId, assetType, response.text, 'voice_change', {
    previousVoice: active.source,
    newVoiceId: newVoiceProfileId,
    newVoiceName: voice.name,
  }, scores, thresholds);
}

/**
 * Run adversarial loop: score -> gate check -> deslop -> re-score, max 3 iterations.
 */
export async function runAdversarialLoopAction(sessionId: string, assetType: string) {
  let active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version');

  const thresholds = await loadSessionThresholds(sessionId);
  let content = active.content;
  let scores = await scoreContent(content);
  let iteration = 0;
  const maxIterations = 3;

  logger.info('Running adversarial loop', { sessionId, assetType });

  while (!checkQualityGates(scores, thresholds) && iteration < maxIterations) {
    iteration++;

    // Deslop if slop is high
    if (scores.slopScore > (thresholds.slopMax ?? 5)) {
      try {
        content = await deslop(content, scores.slopAnalysis);
      } catch { /* continue */ }
    }

    // Refinement pass
    const issues: string[] = [];
    if (scores.vendorSpeakScore > (thresholds.vendorSpeakMax ?? 5)) {
      issues.push(`Vendor-speak score ${scores.vendorSpeakScore.toFixed(1)} exceeds max ${thresholds.vendorSpeakMax}. Replace vendor language with practitioner language.`);
    }
    if (scores.specificityScore < (thresholds.specificityMin ?? 6)) {
      issues.push(`Specificity score ${scores.specificityScore.toFixed(1)} below min ${thresholds.specificityMin}. Add concrete details.`);
    }
    if (scores.personaAvgScore < (thresholds.personaMin ?? 6)) {
      issues.push(`Persona fit score ${scores.personaAvgScore.toFixed(1)} below min ${thresholds.personaMin}. Better match the target audience.`);
    }

    if (issues.length > 0) {
      const refinementPrompt = `Fix these quality issues in this ${assetType.replace(/_/g, ' ')}:\n${issues.map(i => `- ${i}`).join('\n')}\n\n## Content\n${content}\n\nOutput ONLY the fixed content.`;
      try {
        const response = await generateWithGemini(refinementPrompt, {
          model: config.ai.gemini.proModel,
          temperature: 0.4,
          maxTokens: 8000,
        });
        content = response.text;
      } catch { break; }
    }

    scores = await scoreContent(content);
  }

  return createVersionAndActivate(sessionId, assetType, content, 'adversarial', {
    iterations: iteration,
    finalScores: scores,
  }, scores, thresholds);
}

export async function runCompetitiveDeepDiveAction(sessionId: string, assetType: string) {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version for competitive dive');

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
    model: config.ai.gemini.proModel,
    temperature: 0.5,
    maxTokens: 8000,
  });

  const scores = await scoreContent(enriched.text);
  const thresholds = await loadSessionThresholds(sessionId);

  return createVersionAndActivate(sessionId, assetType, enriched.text, 'competitive_dive', {
    researchLength: researchContext.length,
    enrichedAt: new Date().toISOString(),
  }, scores, thresholds);
}

export async function runCommunityCheckAction(sessionId: string, assetType: string) {
  const active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version for community check');

  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  // Load pain point for context
  let painPoint: any = null;
  if (session.painPointId) {
    painPoint = await db.query.discoveredPainPoints.findFirst({ where: eq(discoveredPainPoints.id, session.painPointId) });
  }

  logger.info('Running community check action', { sessionId, assetType });

  const productDocs = await loadSessionProductDocs(session);
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const discoveryContext = formatInsightsForDiscovery(insights);
  const inference = await extractKeywordsAndSources(session, painPoint, discoveryContext);

  if (inference.keywords.length === 0) {
    throw new Error('Could not extract keywords from session context');
  }

  logger.info('Extracted keywords for community check', { keywords: inference.keywords });

  // Hit 5 discovery sources in parallel
  const sourceConfigs: SourceConfig = {
    keywords: inference.keywords,
    subreddits: inference.subreddits,
    tags: inference.stackOverflowTags,
    repositories: inference.githubRepos,
    discourseForums: inference.discourseForums.length > 0 ? inference.discourseForums : inferDiscourseForums(inference.keywords),
    maxResults: 10,
  };

  const [redditPosts, hnPosts, soPosts, ghPosts, discoursePosts] = await Promise.all([
    discoverFromReddit(sourceConfigs).catch((err) => { logger.warn('Reddit discovery failed', { error: String(err) }); return []; }),
    discoverFromHackerNews(sourceConfigs).catch((err) => { logger.warn('HN discovery failed', { error: String(err) }); return []; }),
    discoverFromStackOverflow(sourceConfigs).catch((err) => { logger.warn('SO discovery failed', { error: String(err) }); return []; }),
    discoverFromGitHub(sourceConfigs).catch((err) => { logger.warn('GitHub discovery failed', { error: String(err) }); return []; }),
    discoverFromDiscourse(sourceConfigs).catch((err) => { logger.warn('Discourse discovery failed', { error: String(err) }); return []; }),
  ]);

  const allPosts = [...redditPosts, ...hnPosts, ...soPosts, ...ghPosts, ...discoursePosts];

  // Also do grounded search for supplemental context
  let groundedContext = '';
  try {
    const groundedResult = await generateWithGeminiGroundedSearch(
      `Find recent practitioner discussions about: ${inference.keywords.slice(0, 3).join(', ')}. Focus on pain points, frustrations, and unmet needs.`
    );
    groundedContext = groundedResult.text;
  } catch (err) {
    logger.warn('Grounded search supplement failed', { error: String(err) });
  }

  if (allPosts.length === 0 && !groundedContext) {
    throw new Error('No community posts found for the extracted keywords');
  }

  // Build community context and rewrite
  const communityContext = buildCommunityContext(allPosts, groundedContext);
  const rewritePrompt = buildCommunityRewritePrompt(active.content, communityContext, assetType);

  const rewritten = await generateWithGemini(rewritePrompt, {
    model: config.ai.gemini.proModel,
    temperature: 0.5,
    maxTokens: 8000,
  });

  const scores = await scoreContent(rewritten.text);
  const thresholds = await loadSessionThresholds(sessionId);

  return createVersionAndActivate(sessionId, assetType, rewritten.text, 'community_check', {
    sourceCounts: {
      reddit: redditPosts.length,
      hackernews: hnPosts.length,
      stackoverflow: soPosts.length,
      github: ghPosts.length,
      discourse: discoursePosts.length,
    },
    totalPosts: allPosts.length,
    keywords: inference.keywords,
    enrichedAt: new Date().toISOString(),
  }, scores, thresholds);
}
