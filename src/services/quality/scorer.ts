// Combined quality scoring orchestrator
// Runs all 5 scoring dimensions and applies voice-profile-specific gates

import { createLogger } from '../../utils/logger.js';
import { analyzeSlop } from './slop-detector.js';
import { analyzeVendorSpeak } from './vendor-speak.js';
import { analyzeSpecificity } from './specificity.js';
import { analyzeAuthenticity } from './authenticity.js';
import { runPersonaCritics } from './persona-critic.js';
import type { GeneratedVariant, ScoredVariant, GenerationContext } from '../generation/types.js';

const logger = createLogger('quality:scorer');

export async function scoreAllVariants(
  variants: GeneratedVariant[],
  context: GenerationContext,
): Promise<ScoredVariant[]> {
  const scoredVariants: ScoredVariant[] = [];

  for (const variant of variants) {
    logger.info('Scoring variant', { voice: variant.voiceProfileId, type: variant.assetType, num: variant.variantNumber });

    // Run all scoring dimensions in parallel
    const [slopAnalysis, vendorAnalysis, specificityAnalysis, authenticityAnalysis, personaResults] = await Promise.all([
      analyzeSlop(variant.content),
      analyzeVendorSpeak(variant.content),
      analyzeSpecificity(variant.content, context.productDocs.map(d => d.content)),
      analyzeAuthenticity(variant.content),
      runPersonaCritics(variant.content),
    ]);

    // Calculate persona average
    const personaAvg = personaResults.length > 0
      ? personaResults.reduce((sum, r) => sum + r.score, 0) / personaResults.length
      : 5;

    const authenticityScore = authenticityAnalysis.score;

    // Find the voice profile's thresholds
    const voiceProfile = context.voiceProfiles.find(v => v.id === variant.voiceProfileId);
    const thresholds = voiceProfile?.scoringThresholds || {
      slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6,
    };

    // Apply quality gates
    const passesGates =
      slopAnalysis.score <= thresholds.slopMax &&
      vendorAnalysis.score <= thresholds.vendorSpeakMax &&
      authenticityScore >= thresholds.authenticityMin &&
      specificityAnalysis.score >= thresholds.specificityMin &&
      personaAvg >= thresholds.personaMin;

    scoredVariants.push({
      ...variant,
      slopScore: slopAnalysis.score,
      vendorSpeakScore: vendorAnalysis.score,
      authenticityScore,
      specificityScore: specificityAnalysis.score,
      personaAvgScore: Math.round(personaAvg * 10) / 10,
      passesGates,
    });

    logger.info('Variant scored', {
      voice: variant.voiceProfileId,
      type: variant.assetType,
      slop: slopAnalysis.score,
      vendor: vendorAnalysis.score,
      authenticity: authenticityScore,
      specificity: specificityAnalysis.score,
      persona: personaAvg,
      passes: passesGates,
    });
  }

  return scoredVariants;
}
