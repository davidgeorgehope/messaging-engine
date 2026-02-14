import { generateWithGemini } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('research:parser');

export interface StructuredResearch {
  painPointSummary: string;
  ourCapabilities: string[];
  competitorApproaches: Array<{
    competitor: string;
    approach: string;
    strengths: string[];
    weaknesses: string[];
  }>;
  competitiveWedge: string;
  practitionerSentiment: string;
  keyQuotes: string[];
  sources: Array<{ title: string; url: string }>;
}

export async function parseResearchOutput(
  rawText: string,
  painPointTitle: string,
): Promise<{ structured: StructuredResearch; markdown: string }> {
  logger.info('Parsing research output', { textLength: rawText.length });

  const extractionPrompt = `Extract structured competitive research from this report about the pain point: "${painPointTitle}"

RESEARCH REPORT:
${rawText.substring(0, 15000)}

Extract into this JSON structure:
{
  "painPointSummary": "1-2 sentence summary of the practitioner pain",
  "ourCapabilities": ["specific product capabilities that address this pain"],
  "competitorApproaches": [
    {
      "competitor": "competitor name",
      "approach": "how they address this pain",
      "strengths": ["what they do well"],
      "weaknesses": ["where they fall short"]
    }
  ],
  "competitiveWedge": "where our approach wins and why",
  "practitionerSentiment": "what practitioners say about existing solutions",
  "keyQuotes": ["verbatim quotes from practitioners if found"],
  "sources": [{"title": "source title", "url": "source url"}]
}

Be specific and factual. Only include what's actually in the research.`;

  const response = await generateWithGemini(extractionPrompt, {
    model: 'pro',
    temperature: 0.1,
    maxTokens: 4096,
  });

  let jsonContent = response.text.trim();

  // Handle markdown code blocks
  const jsonMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonContent = jsonMatch[1].trim();
  }

  // Extract JSON if wrapped in other text
  if (!jsonContent.startsWith('{')) {
    const jsonStart = jsonContent.indexOf('{');
    const jsonEnd = jsonContent.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      jsonContent = jsonContent.slice(jsonStart, jsonEnd + 1);
    }
  }

  const structured = JSON.parse(jsonContent) as StructuredResearch;

  // Generate markdown summary
  const markdown = generateMarkdown(structured, painPointTitle);

  return { structured, markdown };
}

function generateMarkdown(research: StructuredResearch, title: string): string {
  let md = `# Competitive Research: ${title}\n\n`;
  md += `## Pain Point\n${research.painPointSummary}\n\n`;
  md += `## Our Capabilities\n${research.ourCapabilities.map(c => `- ${c}`).join('\n')}\n\n`;

  if (research.competitorApproaches.length > 0) {
    md += `## Competitor Approaches\n`;
    for (const comp of research.competitorApproaches) {
      md += `### ${comp.competitor}\n${comp.approach}\n`;
      md += `**Strengths:** ${comp.strengths.join(', ')}\n`;
      md += `**Weaknesses:** ${comp.weaknesses.join(', ')}\n\n`;
    }
  }

  md += `## Competitive Wedge\n${research.competitiveWedge}\n\n`;
  md += `## Practitioner Sentiment\n${research.practitionerSentiment}\n\n`;

  if (research.keyQuotes.length > 0) {
    md += `## Key Quotes\n${research.keyQuotes.map(q => `> "${q}"`).join('\n\n')}\n\n`;
  }

  if (research.sources.length > 0) {
    md += `## Sources\n${research.sources.map(s => `- [${s.title}](${s.url})`).join('\n')}\n`;
  }

  return md;
}
