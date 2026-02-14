import { generateWithGemini } from '../ai/clients.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:grounding-validator');

// Patterns that indicate fabricated community references
const FABRICATION_PATTERNS = [
  /as one [\w\s]+ on r\/\w+/gi,
  /as one [\w\s]+ (noted|pointed out|mentioned|shared|put it|observed|explained|wrote)/gi,
  /practitioners (report|say|note|observe|confirm|agree|mention|describe)/gi,
  /community (sentiment|consensus|feedback|discussions?) (suggests?|indicates?|shows?|confirms?|reveals?)/gi,
  /"[^"]{10,}" — (Reddit|Hacker News|Stack Overflow|GitHub|r\/)/gi,
  /according to (practitioners|engineers|developers|teams|users) (on|in|across|from) /gi,
  /a (senior |lead |staff )?(engineer|developer|SRE|DevOps|practitioner|architect) (on|in|at) (Reddit|HN|Hacker News|Stack Overflow)/gi,
  /forum (posts?|threads?|discussions?) (indicate|show|suggest|reveal|confirm)/gi,
  /in (a |one )?(recent |popular )?(Reddit|HN|Hacker News|Stack Overflow|GitHub) (thread|post|discussion|comment)/gi,
];

export interface GroundingValidationResult {
  hasFabricationPatterns: boolean;
  fabricationCount: number;
  matchedPatterns: string[];
  strippedContent?: string;
  fabricationStripped: boolean;
}

/**
 * Check generated content for fabrication patterns.
 * If fabrication found AND evidence level is 'product-only', strip fabrications via LLM.
 */
export async function validateGrounding(
  content: string,
  evidenceLevel: 'strong' | 'partial' | 'product-only',
): Promise<GroundingValidationResult> {
  const matches: string[] = [];

  for (const pattern of FABRICATION_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[0]);
    }
  }

  const hasFabricationPatterns = matches.length > 0;

  if (!hasFabricationPatterns || evidenceLevel !== 'product-only') {
    return {
      hasFabricationPatterns,
      fabricationCount: matches.length,
      matchedPatterns: matches,
      fabricationStripped: false,
    };
  }

  // Fabrication found AND no real evidence — strip it
  logger.warn('Fabrication patterns detected in product-only content, stripping', {
    fabricationCount: matches.length,
    patterns: matches.slice(0, 5),
  });

  try {
    const strippingPrompt = `Remove all fabricated practitioner quotes and community references from this content. The content was generated WITHOUT any real community evidence, so any references to Reddit threads, practitioner quotes, community sentiment, forum discussions, etc. are fabricated.

## Content to Clean
${content}

## Rules
1. Remove or rewrite any sentence that references community discussions, practitioner quotes, Reddit/HN/SO threads, or "engineers say..."
2. Replace fabricated social proof with product-doc-grounded claims or mark as [Needs community validation]
3. Keep all factual product claims and genuine insights
4. Maintain the same structure and format
5. Do NOT add new fabricated references

Output ONLY the cleaned content.`;

    const response = await generateWithGemini(strippingPrompt, {
      model: config.ai.gemini.proModel,
      temperature: 0.3,
      maxTokens: 16000,
    });

    return {
      hasFabricationPatterns: true,
      fabricationCount: matches.length,
      matchedPatterns: matches,
      strippedContent: response.text,
      fabricationStripped: true,
    };
  } catch (error) {
    logger.error('Fabrication stripping failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Return original content with warning
    return {
      hasFabricationPatterns: true,
      fabricationCount: matches.length,
      matchedPatterns: matches,
      fabricationStripped: false,
    };
  }
}
