// Shared product insights module — single source of truth for product doc intelligence.
// All pipelines extract insights once, then use tiered formatters for each context.

import { generateWithGemini } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('product:insights');

export interface ExtractedInsights {
  productCapabilities: string[];
  keyDifferentiators: string[];
  targetPersonas: string[];
  painPointsAddressed: string[];
  claimsAndMetrics: string[];
  technicalDetails: string[];
  summary: string;
  domain: string;
  category: string;
  productType: string;
}

/**
 * Extract structured product intelligence from raw docs using Gemini Flash.
 * Reads up to 200K chars (well within Gemini Flash 1M token context).
 */
export async function extractInsights(productDocs: string): Promise<ExtractedInsights | null> {
  try {
    const truncated = productDocs.substring(0, 200000);
    const prompt = `Analyze the following product documentation and extract structured insights.

## Documentation
${truncated}

Return a JSON object with these fields:
- "productCapabilities": array of specific product capabilities/features (max 12)
- "keyDifferentiators": array of what makes this product different from alternatives (max 8)
- "targetPersonas": array of who this product is for, with their roles and concerns (max 6)
- "painPointsAddressed": array of specific practitioner pain points this product solves (max 10)
- "claimsAndMetrics": array of concrete claims, numbers, benchmarks, or performance metrics (max 10)
- "technicalDetails": array of important technical details, integrations, or architecture notes (max 8)
- "summary": a 2-3 sentence summary of what this product does and why it matters
- "domain": the broad industry domain (e.g. "observability", "security", "databases", "CI/CD")
- "category": the product category within that domain (e.g. "log management", "SIEM", "APM")
- "productType": the type of product (e.g. "SaaS platform", "open-source tool", "managed service", "on-prem appliance")

Be specific. Extract actual details, not generic descriptions. If the docs mention specific numbers, include them.

IMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`;

    const response = await generateWithGemini(prompt, {
      temperature: 0.2,
      maxTokens: 4000,
    });

    let jsonText = response.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(jsonText) as Partial<ExtractedInsights>;

    // Default new fields if model omits them
    return {
      productCapabilities: parsed.productCapabilities ?? [],
      keyDifferentiators: parsed.keyDifferentiators ?? [],
      targetPersonas: parsed.targetPersonas ?? [],
      painPointsAddressed: parsed.painPointsAddressed ?? [],
      claimsAndMetrics: parsed.claimsAndMetrics ?? [],
      technicalDetails: parsed.technicalDetails ?? [],
      summary: parsed.summary ?? '',
      domain: parsed.domain ?? 'unknown',
      category: parsed.category ?? 'unknown',
      productType: parsed.productType ?? 'unknown',
    };
  } catch (error) {
    logger.error('Document insight extraction failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Structured fallback when extractInsights() fails.
 * Extracts minimal signal from raw docs without AI.
 */
export function buildFallbackInsights(productDocs: string): ExtractedInsights {
  // Take first ~2K chars, split into sentences, use as rough summary
  const excerpt = productDocs.substring(0, 2000).trim();
  const firstSentences = excerpt.split(/[.!?]\s+/).slice(0, 3).join('. ') + '.';

  return {
    productCapabilities: [],
    keyDifferentiators: [],
    targetPersonas: [],
    painPointsAddressed: [],
    claimsAndMetrics: [],
    technicalDetails: [],
    summary: firstSentences,
    domain: 'unknown',
    category: 'unknown',
    productType: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Tiered formatters — each returns the right amount of context for its use case
// ---------------------------------------------------------------------------

/**
 * ~150 chars. Used for community search and keyword extraction.
 * Only domain/category/productType — no product framing that could seed vendor bias.
 */
export function formatInsightsForDiscovery(insights: ExtractedInsights): string {
  const parts = [insights.domain, insights.category, insights.productType]
    .filter(p => p && p !== 'unknown');
  if (parts.length === 0) return '';
  return parts.join(' / ');
}

/**
 * ~1-2K chars. Used for competitive research prompts.
 * Summary + capabilities + differentiators + personas — enough for competitor ID.
 */
export function formatInsightsForResearch(insights: ExtractedInsights): string {
  const sections: string[] = [];

  if (insights.summary) {
    sections.push(`Product: ${insights.summary}`);
  }
  if (insights.productCapabilities.length > 0) {
    sections.push(`Capabilities:\n${insights.productCapabilities.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.keyDifferentiators.length > 0) {
    sections.push(`Key Differentiators:\n${insights.keyDifferentiators.map(d => `- ${d}`).join('\n')}`);
  }
  if (insights.targetPersonas.length > 0) {
    sections.push(`Target Personas:\n${insights.targetPersonas.map(p => `- ${p}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * ~2-3K chars. Used for generation prompts (the full picture).
 * All insight fields formatted for Claude/Gemini consumption.
 */
export function formatInsightsForPrompt(insights: ExtractedInsights): string {
  const sections: string[] = [];

  sections.push(`### Product Summary\n${insights.summary}`);

  if (insights.painPointsAddressed.length > 0) {
    sections.push(`### Pain Points Addressed\n${insights.painPointsAddressed.map(p => `- ${p}`).join('\n')}`);
  }
  if (insights.productCapabilities.length > 0) {
    sections.push(`### Capabilities\n${insights.productCapabilities.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.keyDifferentiators.length > 0) {
    sections.push(`### Key Differentiators\n${insights.keyDifferentiators.map(d => `- ${d}`).join('\n')}`);
  }
  if (insights.claimsAndMetrics.length > 0) {
    sections.push(`### Claims & Metrics\n${insights.claimsAndMetrics.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.targetPersonas.length > 0) {
    sections.push(`### Target Personas\n${insights.targetPersonas.map(p => `- ${p}`).join('\n')}`);
  }
  if (insights.technicalDetails.length > 0) {
    sections.push(`### Technical Details\n${insights.technicalDetails.map(t => `- ${t}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * ~1-2K chars. Used for quality scoring context.
 * Capabilities + claims + differentiators — what the scorer needs to check specificity.
 */
export function formatInsightsForScoring(insights: ExtractedInsights): string {
  const sections: string[] = [];

  if (insights.productCapabilities.length > 0) {
    sections.push(`Capabilities:\n${insights.productCapabilities.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.claimsAndMetrics.length > 0) {
    sections.push(`Claims & Metrics:\n${insights.claimsAndMetrics.map(c => `- ${c}`).join('\n')}`);
  }
  if (insights.keyDifferentiators.length > 0) {
    sections.push(`Differentiators:\n${insights.keyDifferentiators.map(d => `- ${d}`).join('\n')}`);
  }

  return sections.join('\n\n');
}
