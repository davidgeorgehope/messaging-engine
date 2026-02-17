// Narrative arc scoring
// Evaluates story structure: progression, tension, resolution, emotional journey, coherence
// Applied to ALL asset types — even a battlecard tells a mini-story (pain → approach → why we win)

import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:narrative-arc');

export interface NarrativeArcAnalysis {
  score: number;  // 0-10 (higher is better)
  progressionMarkers: string[];
  tensionElements: string[];
  coherenceIssues: string[];
  assessment: string;
}

export async function analyzeNarrativeArc(content: string): Promise<NarrativeArcAnalysis> {
  const prompt = `Analyze this messaging content for narrative arc — does it tell a coherent story with progression, tension, and resolution?

CONTENT:
${content.substring(0, 2500)}

Evaluate:
1. Progression — Does it build from problem to solution? Is there a clear beginning/middle/end?
2. Tension — Is there conflict, stakes, or urgency that pulls the reader forward?
3. Resolution — Does the tension get addressed? Does the reader feel satisfied?
4. Emotional Journey — Does the reader go through distinct emotional states (frustration → hope → excitement)?
5. Coherence — Do the parts connect logically? Does each section build on the previous?

Respond with JSON:
{
  "score": <0-10, where 10 is a masterfully structured narrative arc and 0 is disjointed content with no story>,
  "progressionMarkers": ["<examples of clear progression found, e.g. 'Opens with problem, builds to insight, resolves with transformation'>"],
  "tensionElements": ["<examples of tension, stakes, or urgency found>"],
  "coherenceIssues": ["<any places where the narrative breaks down or sections feel disconnected>"],
  "assessment": "<1-2 sentence summary>"
}`;

  try {
    const response = await generateJSON<NarrativeArcAnalysis>(prompt, { temperature: 0.2, retryOnParseError: true, maxParseRetries: 2 });
    return response.data;
  } catch (error) {
    logger.error('Narrative arc analysis failed', { error });
    return { score: 5, progressionMarkers: [], tensionElements: [], coherenceIssues: [], assessment: 'Analysis unavailable' };
  }
}
