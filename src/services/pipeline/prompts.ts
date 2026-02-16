import type { VoiceProfile, ScoringThresholds } from '../../types/index.js';
// Pipeline prompt builders, templates, and constants
// Extracted from src/api/generate.ts

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { AssetType } from '../../services/generation/types.js';
import type { ExtractedInsights, DeepPoVInsights } from '../../services/product/insights.js';
import { formatInsightsForPrompt, formatInsightsForResearch } from '../../services/product/insights.js';
import { generateWithGemini } from '../../services/ai/clients.js';
import { getModelForTask } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { ScoreResults } from '../../services/quality/score-content.js';
import type { EvidenceBundle } from './evidence.js';

const logger = createLogger('pipeline:prompts');

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

export async function loadTemplate(assetType: AssetType): Promise<string> {
  try {
    const filename = assetType.replace(/_/g, '-') + '.md';
    return await readFile(join(TEMPLATE_DIR, filename), 'utf-8');
  } catch {
    return `Generate ${ASSET_TYPE_LABELS[assetType] || assetType} content.`;
  }
}

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

const DEFAULT_BANNED_WORDS = [
  "industry-leading", "best-in-class", "next-generation", "enterprise-grade",
  "mission-critical", "turnkey", "end-to-end", "single pane of glass",
  "seamless", "robust", "leverage", "cutting-edge", "game-changer"
];

export async function generateBannedWords(voice: VoiceProfile, insights: ExtractedInsights): Promise<string[]> {
  const prompt = `Given this voice profile and product domain, list 15-20 specific words and phrases that would sound inauthentic, vendor-heavy, or like AI-generated marketing copy to the target audience. Return ONLY a JSON array of strings.

Voice: ${voice.name} — ${voice.description}
${voice.voiceGuide ? `Voice Guide: ${voice.voiceGuide.substring(0, 500)}` : ''}
Domain: ${insights.domain} / ${insights.category}
Target personas: ${insights.targetPersonas.join(', ')}

Return ONLY a JSON array like: ["phrase1", "phrase2", ...]`;

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await generateWithGemini(prompt, { model: getModelForTask('flash'), temperature: 0.2, maxTokens: 1000 });
      const cleaned = response.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.info('Generated dynamic banned words', { voice: voice.name, count: parsed.length, attempt });
        return parsed;
      }
      logger.warn('Banned words response was not a valid array, retrying', { voice: voice.name, attempt, raw: cleaned.substring(0, 200) });
    } catch (err) {
      logger.warn('Failed to generate dynamic banned words', {
        voice: voice.name,
        attempt,
        maxRetries: MAX_RETRIES,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  logger.error('All banned words retries exhausted, using defaults', { voice: voice.name });
  return DEFAULT_BANNED_WORDS;
}

// Cache: voiceId:domain -> banned words (per-process, cleared on restart)
export const bannedWordsCache = new Map<string, string[]>();

export async function getBannedWordsForVoice(voice: VoiceProfile, insights: ExtractedInsights): Promise<string[]> {
  const cacheKey = `${voice.id}:${insights.domain || 'unknown'}`;
  if (bannedWordsCache.has(cacheKey)) return bannedWordsCache.get(cacheKey)!;
  const words = await generateBannedWords(voice, insights);
  bannedWordsCache.set(cacheKey, words);
  return words;
}

export function buildSystemPrompt(voice: VoiceProfile, assetType: AssetType, evidenceLevel?: EvidenceBundle['evidenceLevel'], pipeline?: 'standard' | 'outside-in', bannedWords?: string[]): string {
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

export function buildPoVFirstPrompt(
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

export function buildPainFirstPrompt(
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

export function buildRefinementPrompt(
  content: string,
  scores: ScoreResults,
  thresholds: ScoringThresholds,
  voice: VoiceProfile,
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

export function buildResearchPromptFromInsights(insights: ExtractedInsights, prompt?: string): string {
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
