import { parseScoringThresholds } from '../../../types/index.js';
// Pipeline: Standard (Research → Generate → Refinement Loop → Store)
// Extracted from src/api/generate.ts

import { createLogger } from '../../../utils/logger.js';
import { getModelForTask } from '../../../config.js';
import { extractInsights, buildFallbackInsights, formatInsightsForScoring, extractDeepPoV } from '../../../services/product/insights.js';
import { nameSessionFromInsights } from '../../../services/workspace/sessions.js';
import { loadTemplate, buildSystemPrompt, buildUserPrompt, buildPoVFirstPrompt, getBannedWordsForVoice, ASSET_TYPE_LABELS, ASSET_TYPE_TEMPERATURE } from '../prompts.js';
import { runCommunityDeepResearch, runCompetitiveResearch } from '../evidence.js';
import { emitPipelineStep, updateJobProgress, generateAndScore, refinementLoop, storeVariant, finalizeJob, type JobInputs } from '../orchestrator.js';
import type { ExtractedInsights } from '../../../services/product/insights.js';

const logger = createLogger('pipeline:standard');

export async function runStandardPipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 0: Deep PoV Extraction
  emitPipelineStep(jobId, 'deep-pov-extraction', 'running', { model: getModelForTask('pro') });
  updateJobProgress(jobId, { status: 'running', currentStep: `Extracting deep product PoV... [${getModelForTask('pro')}]`, progress: 2 });
  const povInsights = await extractDeepPoV(productDocs);
  const insights: ExtractedInsights = povInsights ?? await extractInsights(productDocs) ?? buildFallbackInsights(productDocs);
  const deepPoV = povInsights;
  await nameSessionFromInsights(jobId, insights, selectedAssetTypes).catch(err => {
    logger.warn('Session naming failed', { jobId, error: err instanceof Error ? err.message : String(err) });
  });
  const scoringContext = formatInsightsForScoring(insights);
  emitPipelineStep(jobId, 'deep-pov-extraction', 'complete');

  // Pre-generate banned words
  const voiceBannedWords = new Map<string, string[]>();
  await Promise.all(selectedVoices.map(async (voice) => {
    voiceBannedWords.set(voice.id, await getBannedWordsForVoice(voice, insights));
  }));

  // Step 1: Community research
  emitPipelineStep(jobId, 'community-validation', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { currentStep: `Validating PoV against community reality... [${getModelForTask('flash')}]`, progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);
  emitPipelineStep(jobId, 'community-validation', 'complete');

  // Step 2: Competitive research
  emitPipelineStep(jobId, 'competitive-research', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { currentStep: `Running competitive research... [${getModelForTask('flash')}]`, progress: 10 });
  let competitivePromptExtra = prompt || '';
  if (evidence.communityContextText) {
    competitivePromptExtra += '\n\nCommunity findings to inform competitive analysis:\n' + evidence.communityContextText.substring(0, 2000);
  }
  const competitiveResult = await runCompetitiveResearch(insights, competitivePromptExtra).catch(error => {
    logger.warn('Competitive research failed, continuing without it', {
      jobId, error: error instanceof Error ? error.message : String(error),
    });
    return '';
  });
  emitPipelineStep(jobId, 'competitive-research', 'complete');

  // Step 3: Generate
  emitPipelineStep(jobId, 'generate', 'running', { model: getModelForTask('pro') });
  updateJobProgress(jobId, { currentStep: `Generating from product narrative... [${getModelForTask('pro')}]`, progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = await loadTemplate(assetType);
    for (const voice of selectedVoices) {
      updateJobProgress(jobId, { currentStep: `Generating ${ASSET_TYPE_LABELS[assetType]} — ${voice.name} [${getModelForTask('pro')}]` });

      const thresholds = parseScoringThresholds(voice.scoringThresholds);

      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = deepPoV
        ? buildSystemPrompt(voice, assetType, evidence.evidenceLevel, 'standard', bannedWords)
        : buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);

      let researchContext = competitiveResult;
      if (evidence.communityContextText) {
        researchContext = researchContext
          ? `${researchContext}\n\n${evidence.communityContextText}`
          : evidence.communityContextText;
      }

      const userPrompt = deepPoV
        ? buildPoVFirstPrompt(deepPoV, evidence.communityContextText, competitiveResult, template, assetType, existingMessaging, prompt)
        : buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);

      try {
        const initial = await generateAndScore(userPrompt, systemPrompt, selectedModel, scoringContext, thresholds, assetType);
        const result = await refinementLoop(initial.content, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt });
      } catch (error) {
        logger.error('Failed to generate variant', {
          jobId, assetType, voice: voice.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      completedItems++;
      updateJobProgress(jobId, { progress: Math.min(Math.round(18 + (completedItems / totalItems) * 77), 95) });
    }
  }

  emitPipelineStep(jobId, 'generate', 'complete');
  const researchLen = (competitiveResult?.length || 0) + (evidence.communityContextText?.length || 0);
  return finalizeJob(jobId, !!(competitiveResult || evidence.communityContextText), researchLen);
}
