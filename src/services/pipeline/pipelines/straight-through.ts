import { parseScoringThresholds } from '../../../types/index.js';
// Pipeline: Straight Through (extract insights → score existing content, no generation)
// Extracted from src/api/generate.ts

import { createLogger } from '../../../utils/logger.js';
import { getModelForTask } from '../../../config.js';
import { scoreContent, checkQualityGates as checkGates } from '../../../services/quality/score-content.js';
import { extractInsights, buildFallbackInsights, formatInsightsForScoring } from '../../../services/product/insights.js';
import { nameSessionFromInsights } from '../../../services/workspace/sessions.js';
import { ASSET_TYPE_LABELS } from '../prompts.js';
import { emitPipelineStep, updateJobProgress, storeVariant, finalizeJob, type JobInputs } from '../orchestrator.js';

const logger = createLogger('pipeline:straight-through');

export async function runStraightThroughPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, selectedVoices } = inputs;

  if (!existingMessaging || existingMessaging.trim().length === 0) {
    logger.error('Straight-through pipeline requires existing messaging content to score', { jobId });
    updateJobProgress(jobId, { status: 'failed', currentStep: 'No existing messaging provided. Straight Through mode scores existing content — paste your messaging to evaluate it.' });
    return;
  }

  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  emitPipelineStep(jobId, 'extract-insights', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { status: 'running', currentStep: 'Extracting product insights...', progress: 5 });
  const insights = await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(() => {});
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'extract-insights', 'complete');

  updateJobProgress(jobId, { currentStep: 'Scoring existing content...', progress: 15 });

  for (const assetType of selectedAssetTypes) {
    for (const voice of selectedVoices) {
      emitPipelineStep(jobId, `score-${assetType}-${voice.slug}`, 'running');
      updateJobProgress(jobId, { currentStep: `Scoring ${ASSET_TYPE_LABELS[assetType]} — ${voice.name}` });

      const thresholds = parseScoringThresholds(voice.scoringThresholds);

      try {
        const scores = await scoreContent(existingMessaging, [scoringContext]);
        const passesGates = checkGates(scores, thresholds);

        await storeVariant(jobId, assetType, voice, existingMessaging, scores, passesGates, prompt);

        emitPipelineStep(jobId, `score-${assetType}-${voice.slug}`, 'complete', {
          draft: existingMessaging,
          scores,
        });
      } catch (error) {
        logger.error('Failed to score content', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(15 + (completedItems / totalItems) * 80), 95) });
    }
  }

  return finalizeJob(jobId, false, 0);
}
