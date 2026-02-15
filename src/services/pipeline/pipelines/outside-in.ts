import { parseScoringThresholds } from '../../../types/index.js';
// Pipeline: Outside-In (practitioner pain first, layered enrichment)
// Extracted from src/api/generate.ts

import { createLogger } from '../../../utils/logger.js';
import { getModelForTask } from '../../../config.js';
import { extractInsights, buildFallbackInsights, formatInsightsForScoring, formatInsightsForPrompt } from '../../../services/product/insights.js';
import { nameSessionFromInsights } from '../../../services/workspace/sessions.js';
import { loadTemplate, buildSystemPrompt, buildPainFirstPrompt, getBannedWordsForVoice, ASSET_TYPE_LABELS, ASSET_TYPE_TEMPERATURE } from '../prompts.js';
import { runCommunityDeepResearch, runCompetitiveResearch } from '../evidence.js';
import { emitPipelineStep, updateJobProgress, generateContent, refinementLoop, storeVariant, finalizeJob, type JobInputs } from '../orchestrator.js';
import { runStandardPipeline } from './standard.js';

const logger = createLogger('pipeline:outside-in');

export async function runOutsideInPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Extract insights
  emitPipelineStep(jobId, 'extract-insights', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 2 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'extract-insights', 'complete');

  // Pre-generate banned words
  const voiceBannedWords = new Map<string, string[]>();
  await Promise.all(selectedVoices.map(async (voice) => {
    voiceBannedWords.set(voice.id, await getBannedWordsForVoice(voice, insights));
  }));

  // Step 2: Community Deep Research
  emitPipelineStep(jobId, 'community-research', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { currentStep: 'Running community Deep Research...', progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);
  emitPipelineStep(jobId, 'community-research', 'complete');

  if (evidence.evidenceLevel === 'product-only') {
    logger.warn('Outside-in pipeline requires community evidence but none was found. Falling back to standard pipeline.', { jobId });
    updateJobProgress(jobId, { currentStep: 'No community evidence found — falling back to standard pipeline...' });
    return runStandardPipeline(jobId, inputs);
  }

  const practitionerContext = evidence.communityContextText;

  updateJobProgress(jobId, { currentStep: 'Generating pain-grounded drafts...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    const template = await loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = parseScoringThresholds(voice.scoringThresholds);
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);

      try {
        // Step 3: Generate pain-grounded first draft
        emitPipelineStep(jobId, `pain-draft-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Generating pain-grounded draft — ${voice.name}` });

        const painFirstPrompt = buildPainFirstPrompt(practitionerContext, template, assetType, insights);
        const firstDraftResponse = await generateContent(painFirstPrompt, { systemPrompt, temperature: ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7 }, selectedModel);
        emitPipelineStep(jobId, `pain-draft-${assetType}-${voice.slug}`, 'complete', { draft: firstDraftResponse.text, model: firstDraftResponse.model });

        // Step 4: Competitive research
        emitPipelineStep(jobId, `competitive-research-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Running competitive research — ${voice.name}` });

        const competitiveContext = await runCompetitiveResearch(insights, prompt).catch(() => '');
        emitPipelineStep(jobId, `competitive-research-${assetType}-${voice.slug}`, 'complete');

        // Step 5: Enrich draft with competitive intel
        emitPipelineStep(jobId, `enrich-competitive-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Enriching with competitive intel — ${voice.name}` });

        const enrichCompetitivePrompt = `Here's the practitioner-grounded draft. Here's competitive research. Update the draft to weave in competitive positioning WITHOUT losing the practitioner voice.

## Practitioner-Grounded Draft
${firstDraftResponse.text}

## Competitive Research
${competitiveContext.substring(0, 5000)}

## Rules
1. Keep the practitioner voice and pain-first structure
2. Add competitive differentiation where it strengthens the narrative
3. Don't add vendor-speak or marketing jargon
4. If the competitive research reveals gaps competitors miss, highlight those
5. Output ONLY the updated content`;

        const enrichedResponse = await generateContent(enrichCompetitivePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        emitPipelineStep(jobId, `enrich-competitive-${assetType}-${voice.slug}`, 'complete', { draft: enrichedResponse.text, model: enrichedResponse.model });

        // Step 6: Layer in product specifics
        emitPipelineStep(jobId, `layer-product-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Layering product specifics — ${voice.name}` });

        const productInsightsText = formatInsightsForPrompt(insights);
        const layerProductPrompt = `Here's the competitively-enriched draft. Here's detailed product intelligence. Add specific product capabilities, metrics, and claims where they strengthen the narrative. Don't vendor-speak it.

## Competitively-Enriched Draft
${enrichedResponse.text}

## Product Intelligence
${productInsightsText}

## Template / Format Guide
${template}

## Rules
1. Add specific product capabilities, metrics, and claims where they strengthen the narrative
2. Don't turn it into a feature list — weave product specifics in naturally
3. Keep the practitioner voice dominant
4. Every product mention should answer "so what?" for the practitioner
5. Output ONLY the final content`;

        const layeredResponse = await generateContent(layerProductPrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        emitPipelineStep(jobId, `layer-product-${assetType}-${voice.slug}`, 'complete', { draft: layeredResponse.text, model: layeredResponse.model });

        // Step 7: Refinement loop
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Refining — ${voice.name}` });

        const result = await refinementLoop(layeredResponse.text, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'complete', { scores: result.scores, scorerHealth: result.scores.scorerHealth });

        // Step 8: Store
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt: painFirstPrompt });
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, !!practitionerContext, practitionerContext?.length ?? 0);
}
