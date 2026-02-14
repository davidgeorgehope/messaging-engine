import { eq, and, desc } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { sessions, sessionVersions, voiceProfiles } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { analyzeSlop, deslop } from '../../services/quality/slop-detector.js';
import { analyzeVendorSpeak } from '../../services/quality/vendor-speak.js';
import { analyzeSpecificity } from '../../services/quality/specificity.js';
import { runPersonaCritics } from '../../services/quality/persona-critic.js';
import type { AssetType } from '../../services/generation/types.js';

const logger = createLogger('workspace:actions');

interface ScoreResults {
  slopScore: number;
  vendorSpeakScore: number;
  authenticityScore: number;
  specificityScore: number;
  personaAvgScore: number;
  slopAnalysis: any;
}

async function scoreContent(content: string): Promise<ScoreResults> {
  const [slopAnalysis, vendorAnalysis, specificityAnalysis, personaResults] = await Promise.all([
    analyzeSlop(content).catch(() => ({ score: 5 })),
    analyzeVendorSpeak(content).catch(() => ({ score: 5 })),
    analyzeSpecificity(content, []).catch(() => ({ score: 5 })),
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
    scores.slopScore <= (thresholds.slopMax ?? 5) &&
    scores.vendorSpeakScore <= (thresholds.vendorSpeakMax ?? 5) &&
    scores.authenticityScore >= (thresholds.authenticityMin ?? 6) &&
    scores.specificityScore >= (thresholds.specificityMin ?? 6) &&
    scores.personaAvgScore >= (thresholds.personaMin ?? 6)
  );
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

  const passesGates = scores && thresholds ? checkGates(scores, thresholds) : false;
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
  // For regenerate, we import and use the generation pipeline
  const { generateWithClaude, generateWithGemini } = await import('../../services/ai/clients.js');
  const { config } = await import('../../config.js');

  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  logger.info('Running regenerate action', { sessionId, assetType });

  // Reload the session's product context
  let productContext = session.productContext || '';
  const docIds = session.productDocIds ? JSON.parse(session.productDocIds) : [];
  if (docIds.length > 0) {
    const { productDocuments } = await import('../../db/schema.js');
    const docs = await Promise.all(
      docIds.map((id: string) => db.query.productDocuments.findFirst({ where: eq(productDocuments.id, id) }))
    );
    const docsText = docs.filter(Boolean).map((d: any) => `## ${d.name}\n${d.content}`).join('\n\n');
    productContext = docsText + (productContext ? `\n\n${productContext}` : '');
  }

  const prompt = `Regenerate ${assetType.replace(/_/g, ' ')} content. Focus on practitioner pain, be specific, avoid vendor-speak.\n\n${productContext.substring(0, 8000)}`;

  const response = await generateWithGemini(prompt, {
    model: config.ai.gemini.proModel,
    temperature: 0.7,
    maxTokens: 8000,
  });

  const scores = await scoreContent(response.text);
  const thresholds = await loadSessionThresholds(sessionId);

  return createVersionAndActivate(sessionId, assetType, response.text, 'regenerate', {
    regeneratedAt: new Date().toISOString(),
  }, scores, thresholds);
}

/**
 * Regenerate with a different voice profile.
 */
export async function runVoiceChangeAction(sessionId: string, assetType: string, newVoiceProfileId: string) {
  const { generateWithGemini } = await import('../../services/ai/clients.js');
  const { config } = await import('../../config.js');

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
  const { generateWithGemini } = await import('../../services/ai/clients.js');
  const { config } = await import('../../config.js');

  let active = await getActiveVersion(sessionId, assetType);
  if (!active) throw new Error('No active version');

  const thresholds = await loadSessionThresholds(sessionId);
  let content = active.content;
  let scores = await scoreContent(content);
  let iteration = 0;
  const maxIterations = 3;

  logger.info('Running adversarial loop', { sessionId, assetType });

  while (!checkGates(scores, thresholds) && iteration < maxIterations) {
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
