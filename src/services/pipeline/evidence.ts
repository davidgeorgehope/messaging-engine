// Evidence bundling and community/competitive research
// Extracted from src/api/generate.ts

import { createLogger } from '../../utils/logger.js';
import { createDeepResearchInteraction, pollInteractionUntilComplete } from '../../services/research/deep-research.js';
import { formatInsightsForDiscovery } from '../../services/product/insights.js';
import type { ExtractedInsights } from '../../services/product/insights.js';
import { buildResearchPromptFromInsights } from './prompts.js';

const logger = createLogger('pipeline:evidence');

export interface PractitionerQuote {
  text: string;
  source: string;
  sourceUrl: string;
}

export interface EvidenceBundle {
  communityPostCount: number;
  practitionerQuotes: PractitionerQuote[];
  communityContextText: string;
  evidenceLevel: 'strong' | 'partial' | 'product-only';
  sourceCounts: Record<string, number>;
  error?: string;
}

export function classifyEvidenceLevel(
  postCount: number,
  sourceTypes: Set<string>,
  hasGroundedSearch: boolean,
): EvidenceBundle['evidenceLevel'] {
  if (postCount >= 3 && sourceTypes.size >= 2) return 'strong';
  if (postCount >= 1 || hasGroundedSearch) return 'partial';
  return 'product-only';
}

export async function runCommunityDeepResearch(insights: ExtractedInsights, prompt?: string): Promise<EvidenceBundle> {
  const emptyBundle: EvidenceBundle = {
    communityPostCount: 0,
    practitionerQuotes: [],
    communityContextText: '',
    evidenceLevel: 'product-only',
    sourceCounts: {},
  };

  const discoveryContext = formatInsightsForDiscovery(insights);

  const deepResearchPrompt = `Search Reddit, Hacker News, Stack Overflow, GitHub Issues, developer blogs, and other practitioner communities for real discussions, complaints, and pain points related to this product area.

## Product Area
${discoveryContext}

${prompt ? `## Focus Area\n${prompt}\n` : ''}
## What to Find
1. Real practitioner quotes expressing frustration with current tools in this space
2. Common complaints and pain points from community discussions
3. What practitioners wish existed or worked better
4. Specific scenarios where current solutions fail them
5. The language practitioners actually use to describe these problems

## Output Format
Organize findings as:
- **Practitioner Quotes**: Verbatim quotes from real community posts (include source URL and community name like "Reddit r/devops" or "HN comment")
- **Common Pain Points**: Recurring themes across communities
- **Wished-For Solutions**: What practitioners say they want
- **Language Patterns**: The specific words and phrases practitioners use (not vendor language)

Be specific. Include actual quotes with source URLs.`;

  try {
    const interactionId = await createDeepResearchInteraction(deepResearchPrompt);
    const result = await pollInteractionUntilComplete(interactionId);

    const practitionerQuotes: PractitionerQuote[] = result.sources.map(s => ({
      text: s.snippet || s.title,
      source: (() => { try { return new URL(s.url).hostname.replace('www.', ''); } catch { return 'web'; } })(),
      sourceUrl: s.url,
    }));

    const uniqueHosts = new Set(result.sources.map(s => {
      try { return new URL(s.url).hostname; } catch { return 'unknown'; }
    }));

    const sourceCounts: Record<string, number> = { deep_research: 1 };
    for (const host of uniqueHosts) {
      sourceCounts[host] = (sourceCounts[host] || 0) + 1;
    }

    const evidenceLevel = classifyEvidenceLevel(
      result.sources.length,
      uniqueHosts,
      result.text.length > 100,
    );

    let contextText = '## Verified Community Evidence (USE ONLY THESE)\n\n';
    contextText += result.text + '\n\n';
    if (result.sources.length > 0) {
      contextText += 'Sources:\n';
      for (const s of result.sources) {
        contextText += `- [${s.title}](${s.url})\n`;
      }
    }

    logger.info('Community Deep Research complete', {
      sourceUrls: result.sources.length,
      uniqueHosts: uniqueHosts.size,
      evidenceLevel,
      textLength: result.text.length,
    });

    return {
      communityPostCount: result.sources.length,
      practitionerQuotes,
      communityContextText: contextText,
      evidenceLevel,
      sourceCounts,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Community Deep Research failed', { error: errorMsg });
    return { ...emptyBundle, error: errorMsg };
  }
}

export async function runCompetitiveResearch(insights: ExtractedInsights, prompt?: string): Promise<string> {
  const researchPrompt = buildResearchPromptFromInsights(insights, prompt);
  const interactionId = await createDeepResearchInteraction(researchPrompt);
  const result = await pollInteractionUntilComplete(interactionId);
  return result.text;
}
