import { parseScoringThresholds } from '../../../types/index.js';
// Pipeline: Adversarial (generate, 2 rounds attack/defend, refinement loop)
// Extracted from src/api/generate.ts

import { createLogger } from '../../../utils/logger.js';
import { getModelForTask } from '../../../config.js';
import { generateWithGemini } from '../../../services/ai/clients.js';
import { extractInsights, buildFallbackInsights, formatInsightsForScoring, formatInsightsForPrompt } from '../../../services/product/insights.js';
import { nameSessionFromInsights } from '../../../services/workspace/sessions.js';
import { loadTemplate, buildSystemPrompt, buildUserPrompt, getBannedWordsForVoice, ASSET_TYPE_LABELS, ASSET_TYPE_TEMPERATURE } from '../prompts.js';
import { runCommunityDeepResearch, runCompetitiveResearch } from '../evidence.js';
import { emitPipelineStep, updateJobProgress, generateContent, refinementLoop, storeVariant, finalizeJob, type JobInputs } from '../orchestrator.js';

const logger = createLogger('pipeline:adversarial');

export async function runAdversarialPipeline(jobId: string, inputs: JobInputs): Promise<void> {
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

  // Step 2: Community research
  emitPipelineStep(jobId, 'community-research', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { currentStep: 'Running community deep research...', progress: 5 });
  const evidence = await runCommunityDeepResearch(insights, prompt);
  emitPipelineStep(jobId, 'community-research', 'complete');

  // Step 3: Competitive research
  emitPipelineStep(jobId, 'competitive-research', 'running', { model: getModelForTask('flash') });
  updateJobProgress(jobId, { currentStep: `Running competitive research... [${getModelForTask('flash')}]`, progress: 10 });
  let competitivePromptExtra = prompt || '';
  if (evidence.communityContextText) {
    competitivePromptExtra += '\n\nCommunity findings to inform competitive analysis:\n' + evidence.communityContextText.substring(0, 2000);
  }
  const competitiveResult = await runCompetitiveResearch(insights, competitivePromptExtra).catch(error => {
    logger.warn('Competitive research failed', { jobId, error: error instanceof Error ? error.message : String(error) });
    return '';
  });
  emitPipelineStep(jobId, 'competitive-research', 'complete');

  let researchContext = competitiveResult;
  if (evidence.communityContextText) {
    researchContext = researchContext
      ? `${researchContext}\n\n${evidence.communityContextText}`
      : evidence.communityContextText;
  }

  updateJobProgress(jobId, { currentStep: 'Generating initial drafts...', progress: 18 });

  for (const assetType of selectedAssetTypes) {
    const template = await loadTemplate(assetType);
    for (const voice of selectedVoices) {
      const thresholds = parseScoringThresholds(voice.scoringThresholds);
      const bannedWords = voiceBannedWords.get(voice.id);
      const systemPrompt = buildSystemPrompt(voice, assetType, evidence.evidenceLevel, undefined, bannedWords);
      const userPrompt = buildUserPrompt(existingMessaging, prompt, researchContext, template, assetType, insights, evidence.evidenceLevel);
      const productInsightsText = formatInsightsForPrompt(insights);

      try {
        // Generate initial draft
        emitPipelineStep(jobId, `draft-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Generating initial draft — ${voice.name}` });
        const initialResponse = await generateContent(userPrompt, { systemPrompt, temperature: ASSET_TYPE_TEMPERATURE[assetType] ?? 0.7 }, selectedModel);
        let currentContent = initialResponse.text;
        emitPipelineStep(jobId, `draft-${assetType}-${voice.slug}`, 'complete', { draft: currentContent });

        // Two rounds of attack/defend
        for (let round = 1; round <= 2; round++) {
          emitPipelineStep(jobId, `attack-r${round}-${assetType}-${voice.slug}`, 'running');
          updateJobProgress(jobId, { currentStep: `Adversarial attack round ${round} — ${voice.name}` });

          const attackPrompt = `You are a hostile, skeptical senior practitioner reviewing vendor messaging. You've been burned by every vendor promise in the last decade. You hate buzzwords, vague claims, and anything that sounds like it was written by someone who has never done the actual work.

Tear apart this ${assetType.replace(/_/g, ' ')} messaging. Be ruthless but specific:

## Messaging to Attack
${currentContent}

## Your Critique Should Cover
1. **Unsubstantiated Claims**: What claims have zero evidence? What would you need to see to believe them?
2. **Vendor-Speak Detection**: Every phrase that sounds like marketing rather than a peer talking. Quote the exact phrases.
3. **Vague Promises**: Where does it hand-wave instead of being specific? What details are missing?
4. **Reality Check**: What would actually happen if a practitioner tried what this messaging implies? Where does it oversimplify?
5. **Missing Objections**: What obvious objections would a buyer raise that this messaging doesn't address?
6. **Credibility Gaps**: Where does this lose trust? What would make you stop reading?

Be brutal. Every weakness you find makes the final output stronger. Format as a numbered list of specific attacks.`;

          const attackResponse = await generateWithGemini(attackPrompt, {
            model: getModelForTask('pro'),
            temperature: 0.6,
          });
          emitPipelineStep(jobId, `attack-r${round}-${assetType}-${voice.slug}`, 'complete');

          emitPipelineStep(jobId, `defend-r${round}-${assetType}-${voice.slug}`, 'running');
          updateJobProgress(jobId, { currentStep: `Defending round ${round} — ${voice.name}` });

          const defendPrompt = `Your ${assetType.replace(/_/g, ' ')} messaging was attacked by a skeptical practitioner. Rewrite it to survive every objection.

## Current Messaging
${currentContent}

## Practitioner Attacks
${attackResponse.text}

## Product Intelligence (for evidence)
${productInsightsText}

## Rules for the Rewrite
1. For every unsubstantiated claim: either add specific evidence from the product intelligence, or remove the claim entirely
2. For every vendor-speak phrase: replace with practitioner language
3. For every vague promise: make it concrete with specifics, or cut it
4. Address the strongest objections directly — don't dodge them
5. Keep the same structure and format as the original
6. The result should feel battle-hardened — every remaining claim can withstand scrutiny

## Template / Format Guide
${template}

Output ONLY the rewritten content. No meta-commentary.`;

          const defendedResponse = await generateContent(defendPrompt, { systemPrompt, temperature: 0.5 }, selectedModel);
          currentContent = defendedResponse.text;
          emitPipelineStep(jobId, `defend-r${round}-${assetType}-${voice.slug}`, 'complete', { draft: currentContent });
        }

        // Refinement loop
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'running');
        updateJobProgress(jobId, { currentStep: `Refining — ${voice.name} [${getModelForTask('pro')}]` });
        const result = await refinementLoop(currentContent, scoringContext, thresholds, voice, assetType, systemPrompt, selectedModel);
        emitPipelineStep(jobId, `refine-${assetType}-${voice.slug}`, 'complete', { scores: result.scores, scorerHealth: result.scores.scorerHealth });

        // Store
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

  return finalizeJob(jobId, !!researchContext, researchContext.length);
}
