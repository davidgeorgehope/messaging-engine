import { parseScoringThresholds } from '../../../types/index.js';
// Pipeline: Multi-Perspective (3 angles → synthesize → refinement loop)
// Extracted from src/api/generate.ts

import { createLogger } from '../../../utils/logger.js';
import { getModelForTask } from '../../../config.js';
import { extractInsights, buildFallbackInsights, formatInsightsForScoring } from '../../../services/product/insights.js';
import { nameSessionFromInsights } from '../../../services/workspace/sessions.js';
import { loadTemplate, buildSystemPrompt, buildUserPrompt, getBannedWordsForVoice, ASSET_TYPE_LABELS, ASSET_TYPE_TEMPERATURE } from '../prompts.js';
import { runCommunityDeepResearch, runCompetitiveResearch } from '../evidence.js';
import { emitPipelineStep, updateJobProgress, generateContent, refinementLoop, storeVariant, finalizeJob, type JobInputs } from '../orchestrator.js';

const logger = createLogger('pipeline:multi-perspective');

export async function runMultiPerspectivePipeline(jobId: string, inputs: JobInputs): Promise<void> {
  const { productDocs, existingMessaging, prompt, assetTypes: selectedAssetTypes, model: selectedModel, selectedVoices } = inputs;
  const totalItems = selectedAssetTypes.length * selectedVoices.length;
  let completedItems = 0;

  // Step 1: Extract insights
  emitPipelineStep(jobId, 'extract-insights', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { status: 'running', currentStep: `Extracting product insights... [${getModelForTask('flash')}]`, progress: 2 });
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

  // Step 2: Community + Competitive Research in parallel
  emitPipelineStep(jobId, 'research', 'running', { model: getModelForTask('deepResearch') });
  updateJobProgress(jobId, { currentStep: `Running community & competitive research... [${getModelForTask('deepResearch')}]`, progress: 5 });

  const [evidence, competitiveResult] = await Promise.all([
    runCommunityDeepResearch(insights, prompt),
    runCompetitiveResearch(insights, prompt).catch(error => {
      logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
      return '';
    }),
  ]);

  let researchContext = competitiveResult;
  if (evidence.communityContextText) {
    researchContext = researchContext
      ? `${researchContext}\n\n${evidence.communityContextText}`
      : evidence.communityContextText;
  }
  emitPipelineStep(jobId, 'research', 'complete');

  updateJobProgress(jobId, { currentStep: 'Generating from multiple perspectives...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = await loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = parseScoringThresholds(voice.scoringThresholds);
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords, insights.productName);

      try {
        const baseContext = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel, insights.productName);

        const empathyAngle = `${baseContext}

## PERSPECTIVE: Practitioner Empathy
Lead ENTIRELY with pain. The reader should feel seen before they see any product mention. Use their language, their frustrations, their daily frustrations and hard-won lessons. Product comes last, almost as an afterthought. Make them nod before you pitch.`;

        const competitiveAngle = `${baseContext}

## PERSPECTIVE: Competitive Positioning
Lead with what current alternatives FAIL at. The reader should recognize the specific frustrations they have with their current tool. Then show what's different — not "better" (that's vendor-speak), but specifically what changes and why it matters for their workflow.`;

        const thoughtLeadershipAngle = `${baseContext}

## PERSPECTIVE: Thought Leadership
Lead with the industry's broken promise — the thing everyone was told would work but doesn't. Frame the problem as systemic, not just a tooling gap. Then present a different way of thinking about it. This should read like an opinionated blog post by someone who's seen the patterns across hundreds of teams.`;

        emitPipelineStep(jobId, `perspectives-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Generating 3 perspectives — ${voice.name}` });

        const perspectiveTemp = ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7;
        const [empathyRes, competitiveRes, thoughtRes] = await Promise.all([
          generateContent(empathyAngle, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
          generateContent(competitiveAngle, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
          generateContent(thoughtLeadershipAngle, { systemPrompt, temperature: perspectiveTemp }, selectedModel),
        ]);
        emitPipelineStep(jobId, `perspectives-${assetType}-${voice.slug}`, 'complete');

        // Synthesize
        emitPipelineStep(jobId, `synthesize-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Synthesizing best elements — ${voice.name}` });

        const synthesizePrompt = `You have 3 versions of the same ${assetType.replace(/_/g, ' ')}, each written from a different angle. Take the strongest elements from each and synthesize them into one superior version.

## Version A: Practitioner Empathy
${empathyRes.text}

## Version B: Competitive Positioning
${competitiveRes.text}

## Version C: Thought Leadership
${thoughtRes.text}

## Synthesis Instructions
1. Take the most authentic pain language from Version A
2. Take the sharpest competitive positioning from Version B
3. Take the strongest narrative arc from Version C
4. Weave them into a single cohesive piece that has: authentic pain + competitive edge + compelling narrative
5. Don't just concatenate — synthesize. The result should feel like one voice, not three stitched together.
6. Keep the same format as the template below.

## Template / Format Guide
${template}

Output ONLY the synthesized content. No meta-commentary.`;

        const synthesizedResponse = await generateContent(synthesizePrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
        emitPipelineStep(jobId, `synthesize-${assetType}-${voice.slug}`, 'complete', { draft: synthesizedResponse.text, model: synthesizedResponse.model });

        // Refinement loop
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Refining — ${voice.name} [${getModelForTask('pro')}]` });
        const result = await refinementLoop(synthesizedResponse.text, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel, 3, insights.productName);
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'complete', { scores: result.scores, scorerHealth: result.scores.scorerHealth });

        // Store
        await storeVariant(jobId, assetType, voice, result.content, result.scores, result.passesGates, prompt, evidence, { systemPrompt, userPrompt: baseContext });
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

  return finalizeJob(jobId, !!researchContext, researchContext.length);
}
