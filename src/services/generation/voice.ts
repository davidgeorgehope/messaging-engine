// Voice enforcement and analysis
// Checks if generated content matches the voice profile's guidelines

import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('generation:voice');

export interface VoiceAnalysis {
  matchScore: number;  // 0-10 how well content matches voice guide
  issues: string[];
  suggestions: string[];
}

export async function analyzeVoiceMatch(
  content: string,
  voiceGuide: string,
  voiceName: string,
): Promise<VoiceAnalysis> {
  const prompt = `Analyze if this messaging content matches the voice profile guidelines.

## Voice Profile: ${voiceName}
${voiceGuide}

## Content to Analyze:
${content.substring(0, 3000)}

Score how well the content matches the voice profile on a 0-10 scale.

Respond with JSON:
{
  "matchScore": <0-10>,
  "issues": ["<specific issues where content doesn't match voice>"],
  "suggestions": ["<specific suggestions to better match voice>"]
}`;

  try {
    const response = await generateJSON<VoiceAnalysis>(prompt, {
      temperature: 0.2,
    });
    return response.data;
  } catch (error) {
    logger.error('Voice analysis failed', { error });
    return { matchScore: 5, issues: [], suggestions: [] };
  }
}
