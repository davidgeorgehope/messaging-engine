// Claude-powered messaging generation
// For each voice profile and asset type, generates 2-3 variants
// Uses templates from /templates/ directory

import { generateWithClaude } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';
import type { GenerationContext, GeneratedVariant, AssetType } from './types.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const logger = createLogger('generation:messaging');

const TEMPLATE_DIR = join(process.cwd(), 'templates');

function loadTemplate(assetType: AssetType): string {
  try {
    const filename = assetType.replace(/_/g, '-') + '.md';
    return readFileSync(join(TEMPLATE_DIR, filename), 'utf-8');
  } catch {
    logger.warn(`Template not found for ${assetType}, using inline template`);
    return getDefaultTemplate(assetType);
  }
}

function getDefaultTemplate(assetType: AssetType): string {
  const templates: Record<AssetType, string> = {
    battlecard: 'Generate a competitive battlecard section for this pain point.',
    talk_track: 'Generate a conversational talk track for sales/field teams.',
    launch_messaging: 'Generate launch messaging (headline + subhead + body).',
    social_hook: 'Generate a short-form social media hook.',
    one_pager: 'Generate a one-pager paragraph for collateral.',
    email_copy: 'Generate outbound email copy.',
    messaging_template: 'Generate a comprehensive messaging positioning document (3000-5000 words) with Key Message, Customer Promises, Proof Points, Use Cases, and Short/Medium/Long descriptions.',
    narrative: 'Generate a storytelling narrative with 3 length variants: VARIANT 1 (~250 words executive summary), VARIANT 2 (~1000 words conference talk), VARIANT 3 (~2500 words full narrative).',
  };
  return templates[assetType];
}

export async function generateMessaging(context: GenerationContext): Promise<GeneratedVariant[]> {
  const variants: GeneratedVariant[] = [];

  for (const voiceProfile of context.voiceProfiles) {
    for (const assetType of context.assetTypes) {
      logger.info('Generating messaging', { voice: voiceProfile.name, assetType });

      const template = loadTemplate(assetType);
      const generated = await generateVariantsForVoice(context, voiceProfile, assetType, template);
      variants.push(...generated);
    }
  }

  logger.info('Messaging generation complete', { totalVariants: variants.length });
  return variants;
}

async function generateVariantsForVoice(
  context: GenerationContext,
  voiceProfile: GenerationContext['voiceProfiles'][0],
  assetType: AssetType,
  template: string,
): Promise<GeneratedVariant[]> {
  const variants: GeneratedVariant[] = [];
  const numVariants = 2; // Generate 2 variants per voice per type

  // Build research context
  const researchContext = context.competitiveResearch
    ? `\n## Competitive Research\n${JSON.stringify(context.competitiveResearch.structuredAnalysis, null, 2)}`
    : '';

  // Build product context
  const productContext = context.productDocs.length > 0
    ? `\n## Product Context\n${context.productDocs.map(d => `### ${d.name}\n${d.content.substring(0, 2000)}`).join('\n\n')}`
    : '';

  // Build quotes context
  const quotesContext = context.painPoint.practitionerQuotes.length > 0
    ? `\n## Practitioner Quotes (use these — they're real)\n${context.painPoint.practitionerQuotes.map(q => `> "${q}"`).join('\n')}`
    : '';

  const systemPrompt = `You are a messaging strategist generating ${assetType.replace(/_/g, ' ')} content.

## Voice Profile: ${voiceProfile.name}
${voiceProfile.voiceGuide}

## Critical Rules
1. Ground ALL claims in the practitioner pain point and research — no invented claims
2. Use practitioner language, not vendor language
3. Reference specific capabilities, not generic value props
4. If practitioner quotes are provided, weave them in naturally
5. Every claim must be traceable to either the pain point, research, or product docs
6. Sound like someone who understands the practitioner's world, not someone selling to them
7. Be specific — names, numbers, scenarios. Vague messaging is bad messaging.
8. DO NOT use: "industry-leading", "best-in-class", "next-generation", "enterprise-grade", "mission-critical", "turnkey", "end-to-end", "single pane of glass", "seamless", "robust", "leverage", "cutting-edge", "game-changer"`;

  for (let i = 0; i < numVariants; i++) {
    const prompt = `Generate variant ${i + 1} of a ${assetType.replace(/_/g, ' ')} for this pain point.

## Pain Point
Title: ${context.painPoint.title}
Content: ${context.painPoint.content}
${quotesContext}
${researchContext}
${productContext}

## Template / Format Guide
${template}

## Priority Area: ${context.priority.name}

Generate the messaging now. Output ONLY the messaging content, no meta-commentary.${i > 0 ? '\n\nThis is variant ' + (i + 1) + ' — take a different angle or emphasis than variant 1.' : ''}`;

    try {
      const response = await generateWithClaude(prompt, {
        systemPrompt,
        temperature: 0.7 + (i * 0.1), // Slightly increase creativity for later variants
      });

      variants.push({
        voiceProfileId: voiceProfile.id,
        variantNumber: i + 1,
        content: response.text,
        assetType,
      });
    } catch (error) {
      logger.error('Failed to generate variant', { voice: voiceProfile.name, assetType, variant: i + 1, error });
    }
  }

  return variants;
}
