// Pipeline spirit validation — LLM-based scoring of whether output matches pipeline intent

import { generateWithGemini } from '../../src/services/ai/clients.js';

interface SpiritScore {
  pipeline: string;
  fidelityScore: number;       // 1-10: how well output matches pipeline intent
  practitionerVoice: number;   // 1-10: sounds like a practitioner, not a vendor
  productDocInfluence: number; // 1-10: how much the product doc dominates (lower = better for outside-in)
  reasoning: string;
}

const PIPELINE_SPIRITS: Record<string, string> = {
  'outside-in': `The outside-in pipeline should produce content that is PRIMARILY driven by real practitioner pain and community voices. Product mentions should be minimal and secondary. The narrative should feel like it was written by someone who lives in the community, not by a vendor. Community quotes and practitioner language should dominate. If the output reads like a product datasheet rewritten with community quotes sprinkled in, it FAILS.`,

  'standard': `The standard pipeline should produce a strong product-led narrative with a clear point of view. It should have a thesis, contrarian take, and opinionated stance. Product capabilities should be front and center, but presented with conviction — not as a feature list. It should read like a thought leader wrote it, not a product marketer.`,

  'adversarial': `The adversarial pipeline should produce content that has been stress-tested. It should acknowledge weaknesses, anticipate objections, and address them head-on. The output should feel battle-hardened — like it survived a hostile Q&A session. Claims should be hedged where appropriate, and competitive positioning should be nuanced rather than dismissive.`,

  'multi-perspective': `The multi-perspective pipeline should present the product from multiple distinct angles (e.g., different personas, different use cases, different levels of technical depth). The synthesis should weave these perspectives together rather than just picking one. The output should feel well-rounded — like multiple smart people contributed to it.`,

  'straight-through': `The straight-through pipeline should score existing content without modifying it. The content should be identical to the input. This is a pass-through for quality scoring only.`,
};

export async function scorePipelineSpirit(pipeline: string, content: string, productDocs: string): Promise<SpiritScore> {
  const spirit = PIPELINE_SPIRITS[pipeline];
  if (!spirit) {
    return { pipeline, fidelityScore: 0, practitionerVoice: 0, productDocInfluence: 0, reasoning: `Unknown pipeline: ${pipeline}` };
  }

  const prompt = `You are evaluating whether a piece of generated messaging content matches the INTENDED SPIRIT of the pipeline that produced it.

## Pipeline: ${pipeline}
## Pipeline Spirit / Intent
${spirit}

## Product Documentation (the input doc)
${productDocs.substring(0, 2000)}

## Generated Content (what the pipeline produced)
${content.substring(0, 5000)}

Score the content on these dimensions (1-10 scale):

1. **fidelity_score**: How well does the output match the pipeline's stated intent/spirit? (10 = perfectly aligned, 1 = completely wrong approach)
2. **practitioner_voice**: How much does this sound like a real practitioner vs. a vendor/marketer? (10 = pure practitioner, 1 = pure marketing)
3. **product_doc_influence**: How heavily does the product documentation dominate the narrative? (10 = output is basically the product doc rewritten, 1 = product doc is barely visible)

Also provide a brief "reasoning" explaining your scores.

Return ONLY valid JSON:
{"fidelity_score": N, "practitioner_voice": N, "product_doc_influence": N, "reasoning": "..."}`;

  const response = await generateWithGemini(prompt, { temperature: 0.2 });
  let jsonText = response.text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(jsonText);
    return {
      pipeline,
      fidelityScore: parsed.fidelity_score ?? 0,
      practitionerVoice: parsed.practitioner_voice ?? 0,
      productDocInfluence: parsed.product_doc_influence ?? 0,
      reasoning: parsed.reasoning ?? '',
    };
  } catch {
    return { pipeline, fidelityScore: 0, practitionerVoice: 0, productDocInfluence: 0, reasoning: `Failed to parse LLM response: ${jsonText.substring(0, 200)}` };
  }
}

// Per-pipeline minimum thresholds
export const SPIRIT_THRESHOLDS: Record<string, { minFidelity: number; maxProductInfluence?: number; minPractitionerVoice?: number }> = {
  'outside-in':       { minFidelity: 6, maxProductInfluence: 5, minPractitionerVoice: 6 },
  'standard':         { minFidelity: 6 },
  'adversarial':      { minFidelity: 6 },
  'multi-perspective': { minFidelity: 6 },
  'straight-through': { minFidelity: 8 },  // should be trivially high since content is unchanged
};
