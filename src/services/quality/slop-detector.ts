// Slop detector — forked from o11y.tips deslop.ts
// Pattern detection + AI analysis + deslop function
// Detects hedging, filler transitions, overused phrases, fake enthusiasm, and cliches

import { generateWithGemini, generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:slop-detector');

// ---------------------------------------------------------------------------
// Slop pattern definitions
// ---------------------------------------------------------------------------

export const SLOP_PATTERNS: Record<string, string[]> = {
  hedging: [
    'it\'s worth noting',
    'it\'s important to note',
    'it should be noted',
    'it bears mentioning',
    'interestingly enough',
    'it\'s no secret that',
    'needless to say',
    'as you might expect',
    'one might argue',
    'it goes without saying',
    'it\'s safe to say',
    'arguably',
    'perhaps unsurprisingly',
    'as it turns out',
    'to be fair',
    'in many ways',
    'in some ways',
    'in a sense',
    'so to speak',
    'if you will',
  ],

  transitions: [
    'let\'s dive in',
    'let\'s dive into',
    'let\'s explore',
    'let\'s take a look',
    'let\'s take a closer look',
    'let\'s unpack',
    'let\'s break down',
    'let\'s examine',
    'without further ado',
    'with that said',
    'with that in mind',
    'that being said',
    'having said that',
    'all things considered',
    'at the end of the day',
    'when all is said and done',
    'the bottom line is',
    'moving forward',
    'going forward',
    'looking ahead',
  ],

  fillers: [
    'in today\'s world',
    'in today\'s landscape',
    'in today\'s fast-paced',
    'in the ever-evolving',
    'in an increasingly',
    'in the realm of',
    'in the world of',
    'when it comes to',
    'at its core',
    'at the heart of',
    'plays a crucial role',
    'plays a vital role',
    'plays a key role',
    'plays an important role',
    'it\'s crucial to',
    'it\'s vital to',
    'it\'s essential to',
    'it\'s important to understand',
    'the reality is',
    'the truth is',
    'the fact of the matter is',
    'the thing is',
    'here\'s the thing',
    'here\'s the deal',
    'whether you\'re a',
    'regardless of whether',
    'no matter your',
  ],

  overused: [
    'game-changer',
    'game changer',
    'paradigm shift',
    'landscape',
    'ecosystem',
    'synergy',
    'leverage',
    'deep dive',
    'holistic',
    'robust',
    'streamline',
    'empower',
    'unlock',
    'unlock the power',
    'harness',
    'harness the power',
    'elevate',
    'supercharge',
    'revolutionize',
    'transformative',
    'groundbreaking',
    'cutting-edge',
    'bleeding-edge',
    'state-of-the-art',
    'next-level',
    'next-generation',
    'double-edged sword',
    'silver bullet',
    'low-hanging fruit',
    'move the needle',
    'boils down to',
    'tip of the iceberg',
  ],

  enthusiasm: [
    'exciting',
    'incredibly',
    'amazing',
    'remarkable',
    'fantastic',
    'wonderful',
    'extraordinary',
    'breathtaking',
    'thrilling',
    'mind-blowing',
    'jaw-dropping',
    'absolutely',
    'truly',
    'simply put',
    'quite simply',
    'make no mistake',
    'rest assured',
    'the good news is',
    'the great news is',
    'the exciting part is',
    'the best part is',
    'what\'s even better',
    'even more impressive',
    'on top of that',
  ],

  cliches: [
    'imagine a world',
    'picture this',
    'think about it',
    'consider this',
    'here\'s the kicker',
    'here\'s where it gets interesting',
    'but wait, there\'s more',
    'buckle up',
    'brace yourself',
    'spoiler alert',
    'fun fact',
    'pro tip',
    'hot take',
    'the million dollar question',
    'the elephant in the room',
    'not all heroes wear capes',
    'the secret sauce',
    'a breath of fresh air',
    'a testament to',
    'a far cry from',
    'only time will tell',
    'the jury is still out',
    'food for thought',
    'stay tuned',
  ],
};

// ---------------------------------------------------------------------------
// Slop analysis types
// ---------------------------------------------------------------------------

export interface SlopMatch {
  pattern: string;
  category: string;
  index: number;
  context: string; // surrounding text
}

export interface SlopAnalysis {
  score: number; // 0-10 (lower is better)
  matches: SlopMatch[];
  matchCount: number;
  categoryCounts: Record<string, number>;
  aiAnalysis?: {
    score: number;
    assessment: string;
    suggestions: string[];
  };
}

// ---------------------------------------------------------------------------
// Pattern-based slop detection
// ---------------------------------------------------------------------------

function detectPatterns(content: string): SlopMatch[] {
  const matches: SlopMatch[] = [];
  const contentLower = content.toLowerCase();

  for (const [category, patterns] of Object.entries(SLOP_PATTERNS)) {
    for (const pattern of patterns) {
      const patternLower = pattern.toLowerCase();
      let searchIdx = 0;

      while (true) {
        const idx = contentLower.indexOf(patternLower, searchIdx);
        if (idx === -1) break;

        // Extract surrounding context (50 chars each side)
        const contextStart = Math.max(0, idx - 50);
        const contextEnd = Math.min(content.length, idx + pattern.length + 50);
        const context = content.substring(contextStart, contextEnd);

        matches.push({
          pattern,
          category,
          index: idx,
          context: context.trim(),
        });

        searchIdx = idx + pattern.length;
      }
    }
  }

  // Sort by position in text
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

export function calculateBaseScore(matches: SlopMatch[], contentLength: number): number {
  if (matches.length === 0) return 0;

  // Weight by category
  const categoryWeights: Record<string, number> = {
    hedging: 0.8,
    transitions: 0.6,
    fillers: 1.0,
    overused: 1.2,
    enthusiasm: 0.9,
    cliches: 1.1,
  };

  let weightedCount = 0;
  for (const match of matches) {
    const weight = categoryWeights[match.category] || 1.0;
    weightedCount += weight;
  }

  // Normalize by content length (per 1000 chars)
  const normalizedCount = (weightedCount / Math.max(contentLength, 100)) * 1000;

  // Scale: 0 matches = 0, ~5 per 1000 chars = 5, ~10+ = 10
  const score = Math.min(10, normalizedCount * 2);
  return Math.round(score * 10) / 10;
}

// ---------------------------------------------------------------------------
// AI-powered slop analysis
// ---------------------------------------------------------------------------

async function getAIAnalysis(content: string): Promise<{ score: number; assessment: string; suggestions: string[] }> {
  const prompt = `Analyze this content for "slop" — filler phrases, hedging language, cliched transitions, fake enthusiasm, and generic padding that adds no information.

CONTENT:
${content.substring(0, 2500)}

Score the slop level 0-10 where:
- 0 = Clean, every word earns its place
- 3 = Minor filler but mostly substantive
- 5 = Noticeable padding and generic phrases
- 7 = Heavy filler, reads like AI-generated content
- 10 = Almost entirely slop

Respond with JSON only:
{
  "score": <0-10>,
  "assessment": "<1-2 sentence summary of slop issues>",
  "suggestions": ["<specific phrase to cut or rewrite>"]
}

IMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`;

  try {
    const response = await generateJSON<{ score: number; assessment: string; suggestions: string[] }>(prompt, {
      temperature: 0.2,
      retryOnParseError: true,
      maxParseRetries: 2,
    });
    return response.data;
  } catch (error) {
    logger.error('AI slop analysis failed', { error });
    return { score: 5, assessment: 'Analysis unavailable', suggestions: [] };
  }
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export async function analyzeSlop(content: string): Promise<SlopAnalysis> {
  // Step 1: Rule-based detection
  const matches = detectPatterns(content);
  const baseScore = calculateBaseScore(matches, content.length);

  // Build category counts
  const categoryCounts: Record<string, number> = {};
  for (const match of matches) {
    categoryCounts[match.category] = (categoryCounts[match.category] || 0) + 1;
  }

  // Step 2: AI analysis
  const aiResult = await getAIAnalysis(content);

  // Combined score: weighted average of rule-based and AI
  const combinedScore = Math.min(10, (baseScore * 0.4 + aiResult.score * 0.6));
  const finalScore = Math.round(combinedScore * 10) / 10;

  return {
    score: finalScore,
    matches,
    matchCount: matches.length,
    categoryCounts,
    aiAnalysis: aiResult,
  };
}

// ---------------------------------------------------------------------------
// Deslop: rewrite content to remove slop
// ---------------------------------------------------------------------------

export async function deslop(content: string, analysis?: SlopAnalysis): Promise<string> {
  // Run analysis if not provided
  const slopAnalysis = analysis ?? await analyzeSlop(content);

  if (slopAnalysis.score <= 2) {
    logger.debug('Content is clean, no deslopping needed', { score: slopAnalysis.score });
    return content;
  }

  // Build a list of specific slop instances found
  const slopExamples = slopAnalysis.matches.slice(0, 15).map(m =>
    `- "${m.pattern}" (${m.category})`
  ).join('\n');

  const prompt = `Rewrite this content to remove slop — filler phrases, hedging, cliched transitions, and generic padding. Keep the meaning and structure intact. Make every word earn its place.

ORIGINAL CONTENT:
${content}

SPECIFIC SLOP FOUND:
${slopExamples}

Rules:
1. Remove or rewrite every flagged phrase
2. Don't add new slop while removing old slop
3. Keep the same structure and meaning
4. Keep technical accuracy
5. Be direct — if a sentence is pure filler, cut it entirely
6. Preserve any specific facts, numbers, or quotes
7. Output ONLY the rewritten content, nothing else`;

  try {
    const response = await generateWithGemini(prompt, {
      useProModel: true,
      temperature: 0.3,
    });

    const cleaned = response.text.trim();

    // Sanity check: the cleaned version shouldn't be dramatically shorter
    // (which might indicate the AI hallucinated or removed too much)
    if (cleaned.length < content.length * 0.3) {
      logger.warn('Deslopped content is suspiciously short, returning original', {
        originalLength: content.length,
        cleanedLength: cleaned.length,
      });
      return content;
    }

    logger.info('Content deslopped', {
      originalLength: content.length,
      cleanedLength: cleaned.length,
      reductionPct: Math.round((1 - cleaned.length / content.length) * 100),
    });

    return cleaned;
  } catch (error) {
    logger.error('Deslop rewrite failed', { error });
    return content;
  }
}

// ---------------------------------------------------------------------------
// Conditional deslop: only rewrites if score exceeds threshold
// ---------------------------------------------------------------------------

export async function deslopIfNeeded(content: string, threshold: number = 5): Promise<{ content: string; wasDeslopped: boolean; analysis: SlopAnalysis }> {
  const analysis = await analyzeSlop(content);

  if (analysis.score <= threshold) {
    return { content, wasDeslopped: false, analysis };
  }

  logger.info('Content exceeds slop threshold, deslopping', {
    score: analysis.score,
    threshold,
    matchCount: analysis.matchCount,
  });

  const cleaned = await deslop(content, analysis);
  return { content: cleaned, wasDeslopped: true, analysis };
}
