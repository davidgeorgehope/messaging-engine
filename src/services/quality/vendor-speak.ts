// Vendor-speak detection
// Detects marketing jargon, empty claims, feature-dumping in messaging

import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:vendor-speak');

const VENDOR_SPEAK_PATTERNS: Record<string, string[]> = {
  buzzwords: [
    'industry-leading', 'best-in-class', 'next-generation', 'enterprise-grade',
    'mission-critical', 'turnkey', 'end-to-end', 'single pane of glass',
    'cutting-edge', 'game-changer', 'paradigm shift', 'synergy',
    'holistic', 'scalable solution', 'digital transformation',
    'best of breed', 'world-class', 'state-of-the-art',
  ],
  empty_claims: [
    'unparalleled', 'unmatched', 'unrivaled', 'unprecedented',
    'the only solution', 'the most powerful', 'the most comprehensive',
    'the fastest', 'the easiest', 'the most intuitive',
  ],
  feature_dumping: [
    'powered by ai', 'machine learning-driven', 'cloud-native',
    'ai-powered', 'ml-based', 'blockchain-enabled',
  ],
  press_release: [
    'we are excited to announce', 'we are pleased to', 'we are proud to',
    'we are thrilled to', 'delighted to share',
    'leading provider of', 'trusted by thousands',
    'empowering teams', 'enabling organizations',
  ],
};

export interface VendorSpeakAnalysis {
  score: number;  // 0-10 (lower is better)
  patterns: Array<{
    type: string;
    examples: string[];
    count: number;
  }>;
  aiAnalysis: {
    score: number;
    assessment: string;
    suggestions: string[];
  };
}

export async function analyzeVendorSpeak(content: string): Promise<VendorSpeakAnalysis> {
  // Rule-based detection
  const patterns = detectPatterns(content);
  const baseScore = calculateBaseScore(patterns);

  // AI analysis
  const aiResult = await getAIAnalysis(content);

  const finalScore = Math.min(10, (baseScore + aiResult.score) / 2);

  return {
    score: Math.round(finalScore * 10) / 10,
    patterns,
    aiAnalysis: aiResult,
  };
}

function detectPatterns(content: string): VendorSpeakAnalysis['patterns'] {
  const contentLower = content.toLowerCase();
  const results: VendorSpeakAnalysis['patterns'] = [];

  for (const [type, phrases] of Object.entries(VENDOR_SPEAK_PATTERNS)) {
    const found: string[] = [];
    let count = 0;

    for (const phrase of phrases) {
      const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = contentLower.match(regex);
      if (matches) {
        found.push(phrase);
        count += matches.length;
      }
    }

    if (found.length > 0) {
      results.push({ type, examples: found.slice(0, 5), count });
    }
  }

  return results;
}

function calculateBaseScore(patterns: VendorSpeakAnalysis['patterns']): number {
  let score = 0;
  const weights: Record<string, number> = {
    buzzwords: 1.0,
    empty_claims: 1.5,
    feature_dumping: 0.8,
    press_release: 1.2,
  };

  for (const pattern of patterns) {
    const weight = weights[pattern.type] || 1.0;
    score += pattern.count * weight;
  }

  return Math.min(10, score / 1.5);
}

async function getAIAnalysis(content: string): Promise<{ score: number; assessment: string; suggestions: string[] }> {
  const prompt = `Analyze this messaging content for vendor-speak and marketing jargon.

CONTENT:
${content.substring(0, 2500)}

Look for:
1. Buzzwords and jargon that practitioners would roll their eyes at
2. Empty superlatives with no evidence ("the best", "unmatched")
3. Feature-dumping without connecting to practitioner pain
4. Press release tone vs practitioner conversation tone
5. Claims that sound like a vendor, not like someone who does the job
6. Vague value props ("saves time", "increases efficiency") without specifics

Respond with JSON:
{
  "score": <0-10, where 0 is pure practitioner voice and 10 is pure vendor marketing>,
  "assessment": "<1-2 sentence summary>",
  "suggestions": ["<specific improvements>"]
}`;

  try {
    const response = await generateJSON<{ score: number; assessment: string; suggestions: string[] }>(prompt, {
      temperature: 0.2,
      retryOnParseError: true,
      maxParseRetries: 2,
    });
    return response.data;
  } catch (error) {
    logger.error('AI vendor-speak analysis failed', { error });
    return { score: 5, assessment: 'Analysis unavailable', suggestions: [] };
  }
}
