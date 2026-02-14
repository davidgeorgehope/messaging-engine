// Specificity scoring
// Measures how specific and concrete the messaging is
// Penalizes vague claims, rewards specific capabilities, numbers, scenarios

import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:specificity');

export interface SpecificityAnalysis {
  score: number;  // 0-10 (higher is better)
  concreteClaims: string[];
  vagueClaims: string[];
  assessment: string;
}

export async function analyzeSpecificity(content: string, productDocs: string[]): Promise<SpecificityAnalysis> {
  const docsContext = productDocs.length > 0
    ? `\nPRODUCT CONTEXT (for verifying claims):\n${productDocs.join('\n').substring(0, 2000)}`
    : '';

  const prompt = `Analyze this messaging content for specificity — how concrete and specific are the claims?

CONTENT:
${content.substring(0, 2500)}
${docsContext}

Evaluate:
1. Does it reference specific product capabilities by name?
2. Does it include numbers, metrics, or quantifiable outcomes?
3. Does it describe specific practitioner scenarios?
4. Are claims backed by evidence or just asserted?
5. Could you swap in any product name and it would still work? (bad sign)

Respond with JSON:
{
  "score": <0-10, where 10 is highly specific and 0 is completely vague>,
  "concreteClaims": ["<specific, verifiable claims found in content>"],
  "vagueClaims": ["<vague, generic claims that could apply to anything>"],
  "assessment": "<1-2 sentence summary>"
}`;

  try {
    const response = await generateJSON<SpecificityAnalysis>(prompt, { temperature: 0.2, retryOnParseError: true, maxParseRetries: 2 });
    return response.data;
  } catch (error) {
    logger.error('Specificity analysis failed', { error });
    return { score: 5, concreteClaims: [], vagueClaims: [], assessment: 'Analysis unavailable' };
  }
}
