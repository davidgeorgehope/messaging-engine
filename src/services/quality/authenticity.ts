// Authenticity scoring
// Measures whether content sounds like a real human wrote it
// Penalizes robotic/template patterns, rewards natural language flow and conversational rhythm

import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:authenticity');

export interface AuthenticityAnalysis {
  score: number;  // 0-10 (higher is better)
  naturalLanguageMarkers: string[];
  roboticPatterns: string[];
  assessment: string;
}

export async function analyzeAuthenticity(content: string): Promise<AuthenticityAnalysis> {
  const prompt = `Analyze this messaging content for authenticity — does it sound like a real human practitioner wrote it, or does it feel AI-generated/templated?

CONTENT:
${content.substring(0, 2500)}

Evaluate:
1. Natural language flow — does it read like someone talking, or like a template filled in?
2. Conversational rhythm — varied sentence lengths, natural pauses, genuine emphasis?
3. Robotic patterns — repetitive structure, predictable transitions, formulaic phrasing?
4. Practitioner voice — does it sound like someone who does this work daily, or an outsider describing it?
5. Genuine perspective — are there real opinions, specific experiences, or just generic statements?

Respond with JSON:
{
  "score": <0-10, where 10 is genuinely human-sounding and 0 is obviously AI-generated>,
  "naturalLanguageMarkers": ["<examples of natural, human-sounding phrases found>"],
  "roboticPatterns": ["<examples of robotic, templated, or AI-like patterns found>"],
  "assessment": "<1-2 sentence summary>"
}`;

  try {
    const response = await generateJSON<AuthenticityAnalysis>(prompt, { temperature: 0.2, retryOnParseError: true, maxParseRetries: 2 });
    return response.data;
  } catch (error) {
    logger.error('Authenticity analysis failed', { error });
    return { score: 5, naturalLanguageMarkers: [], roboticPatterns: [], assessment: 'Analysis unavailable' };
  }
}
