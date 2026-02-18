import { getModelForTask } from '../../config.js';
import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:grounding-validator');

export interface GroundingValidationResult {
  hasFabricationPatterns: boolean;
  fabricationCount: number;
  matchedPatterns: string[];
  strippedContent?: string;
  fabricationStripped: boolean;
}

/**
 * Check generated content for fabricated community references.
 * - For 'strong' or 'partial' evidence: skip check (content is grounded)
 * - For 'product-only': single LLM call to detect AND strip fabrications
 * - Fails open on error: returns fabricationStripped: false
 */
export async function validateGrounding(
  content: string,
  evidenceLevel: 'strong' | 'partial' | 'product-only',
): Promise<GroundingValidationResult> {
  // Content backed by real evidence — no fabrication check needed
  if (evidenceLevel === 'strong' || evidenceLevel === 'partial') {
    return {
      hasFabricationPatterns: false,
      fabricationCount: 0,
      matchedPatterns: [],
      fabricationStripped: false,
    };
  }

  // product-only: LLM-based fabrication detection + stripping
  try {
    const prompt = `Analyze the following content that was generated WITHOUT any real community evidence. Identify any fabricated community references — quotes attributed to practitioners, references to forum discussions, claims about community sentiment, or citations of specific posts on Reddit, Hacker News, Stack Overflow, GitHub, or other community sites.

## Content to Analyze
${content}

## Instructions
1. Find all fabricated community references (fake quotes, invented forum threads, fabricated practitioner testimonials, made-up community sentiment claims)
2. List each fabricated reference as a short description
3. Produce a cleaned version of the content with fabrications removed or replaced with product-doc-grounded claims or "[Needs community validation]" markers
4. Keep all factual product claims and genuine insights
5. Maintain the same structure and format

Return JSON:
{
  "fabricatedReferences": ["<short description of each fabricated reference found>"],
  "cleanedContent": "<the content with fabrications removed/replaced>"
}`;

    const response = await generateJSON<{
      fabricatedReferences: string[];
      cleanedContent: string;
    }>(prompt, {
      model: getModelForTask('pro'),
      temperature: 0.3,
      retryOnParseError: true,
      maxParseRetries: 1,
    });

    const { fabricatedReferences, cleanedContent } = response.data;
    const hasFabrications = fabricatedReferences.length > 0;

    if (hasFabrications) {
      logger.warn('Fabrication patterns detected in product-only content, stripping', {
        fabricationCount: fabricatedReferences.length,
        patterns: fabricatedReferences.slice(0, 5),
      });
    }

    return {
      hasFabricationPatterns: hasFabrications,
      fabricationCount: fabricatedReferences.length,
      matchedPatterns: fabricatedReferences,
      strippedContent: hasFabrications ? cleanedContent : undefined,
      fabricationStripped: hasFabrications,
    };
  } catch (error) {
    logger.error('Fabrication detection failed, failing open', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail open — return original content without stripping
    return {
      hasFabricationPatterns: false,
      fabricationCount: 0,
      matchedPatterns: [],
      fabricationStripped: false,
    };
  }
}
