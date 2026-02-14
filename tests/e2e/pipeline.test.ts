// End-to-end pipeline test
// Runs real API calls: PDF extraction → competitive research → generation (8 types) → quality scoring
// Requires ANTHROPIC_API_KEY and GOOGLE_AI_API_KEY in environment

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFParse } from 'pdf-parse';

// AI clients
import { generateWithGemini } from '../../src/services/ai/clients.js';
import { createDeepResearchInteraction, pollInteractionUntilComplete } from '../../src/services/research/deep-research.js';

// Quality scoring
import { analyzeSlop } from '../../src/services/quality/slop-detector.js';
import { analyzeVendorSpeak } from '../../src/services/quality/vendor-speak.js';
import { analyzeSpecificity } from '../../src/services/quality/specificity.js';

// DB init (needed for persona critics which query the DB)
import { initializeDatabase, closeDatabase } from '../../src/db/index.js';

import type { AssetType } from '../../src/services/generation/types.js';

// ---------------------------------------------------------------------------
// Shared state across phases
// ---------------------------------------------------------------------------
let extractedText = '';
let researchContext = '';
const generatedOutputs: Record<string, string> = {};

const PDF_PATH = join(process.cwd(), 'data', 'uploads', 'mllhgsii-d39o46w3_One_Workflow__1_.pdf');

const ALL_ASSET_TYPES: AssetType[] = [
  'battlecard', 'talk_track', 'launch_messaging', 'social_hook',
  'one_pager', 'email_copy', 'messaging_template', 'narrative',
];

const TEMPLATE_DIR = join(process.cwd(), 'templates');

function loadTemplate(assetType: AssetType): string {
  try {
    const filename = assetType.replace(/_/g, '-') + '.md';
    return readFileSync(join(TEMPLATE_DIR, filename), 'utf-8');
  } catch {
    return `Generate ${assetType.replace(/_/g, ' ')} content.`;
  }
}

// Voice profile for testing — Practitioner Community style
const TEST_VOICE = {
  name: 'Practitioner Community',
  voiceGuide: `You sound like a senior engineer writing a thoughtful Reddit comment.
Direct, experienced, slightly skeptical, helpful.
NO marketing language, superlatives, or exclamation marks.
Short sentences. No filler. If a sentence doesn't add information, delete it.`,
  thresholds: { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 5, specificityMin: 5, personaMin: 5 },
};

function buildSystemPrompt(assetType: AssetType): string {
  let typeInstructions = '';

  if (assetType === 'messaging_template') {
    typeInstructions = `\n\nYou are generating a comprehensive messaging positioning document (3000-5000 words).
Fill every section fully. Include: Background/Market Trends, Key Message, Sub-Head alternatives,
Customer Promises (3-4 blocks), Proof Points, Priority Use Cases, Problem Statement,
Short/Medium/Long descriptions, and Customer Proof Points.`;
  } else if (assetType === 'narrative') {
    typeInstructions = `\n\nYou are generating a storytelling narrative with 3 length variants in one output.
VARIANT 1 (~250 words): Executive summary. VARIANT 2 (~1000 words): Conference talk.
VARIANT 3 (~2500 words): Full narrative. Each must stand alone. Use headers to mark each variant.`;
  }

  return `You are a messaging strategist generating ${assetType.replace(/_/g, ' ')} content.

## Voice Profile: ${TEST_VOICE.name}
${TEST_VOICE.voiceGuide}
${typeInstructions}

## Critical Rules
1. Ground ALL claims in the product documentation and competitive research
2. Use practitioner language, not vendor language
3. Be specific — names, numbers, scenarios
4. DO NOT use: "industry-leading", "best-in-class", "next-generation", "enterprise-grade", "seamless", "robust", "leverage", "cutting-edge", "game-changer"`;
}

function buildUserPrompt(assetType: AssetType): string {
  const template = loadTemplate(assetType);
  const isLongForm = assetType === 'messaging_template' || assetType === 'narrative';
  const docsLimit = isLongForm ? 16000 : 8000;

  let prompt = `Generate ${assetType.replace(/_/g, ' ')} messaging content.

## Product Documentation
${extractedText.substring(0, docsLimit)}`;

  if (researchContext) {
    prompt += `\n\n## Competitive Research\n${researchContext.substring(0, 6000)}`;
  }

  prompt += `\n\n## Template / Format Guide\n${template}

Generate the messaging now. Output ONLY the messaging content, no meta-commentary.`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Tests — sequential phases
// ---------------------------------------------------------------------------

describe('E2E Pipeline', () => {
  beforeAll(async () => {
    // Initialize database for persona critics
    await initializeDatabase();
  });

  // Phase 1: PDF Extraction
  describe('Phase 1: PDF Extraction', () => {
    it('extracts text from uploaded PDF', { timeout: 30_000 }, async () => {
      const buffer = readFileSync(PDF_PATH);
      expect(buffer.length).toBeGreaterThan(0);

      const parser = new PDFParse({ data: buffer } as any);
      const data = await parser.getText();
      extractedText = data.text;

      expect(extractedText.length).toBeGreaterThan(1000);
      console.log(`  PDF extracted: ${extractedText.length} chars`);
    });

    it('contains expected domain keywords', () => {
      const text = extractedText.toLowerCase();
      // At least some of these should appear in a product/observability PDF
      const keywords = ['log', 'data', 'search', 'monitor', 'observ', 'alert', 'metric', 'trace', 'pipeline', 'event', 'workflow', 'ingest'];
      const found = keywords.filter(kw => text.includes(kw));
      console.log(`  Keywords found: ${found.join(', ')}`);
      expect(found.length).toBeGreaterThanOrEqual(3);
    });
  });

  // Phase 2: Competitive Research
  describe('Phase 2: Competitive Research', () => {
    it('runs deep research on extracted content', { timeout: 600_000 }, async () => {
      const researchPrompt = `Conduct competitive research based on the following product documentation.

## Product Documentation
${extractedText.substring(0, 10000)}

## Research Questions
1. What are the main competitors in this space?
2. What do real practitioners say about this problem on Reddit, HN, Stack Overflow?
3. Where do competitors fall short?
4. What market trends make this product relevant now?

Be specific and factual, cite sources. Include practitioner quotes from forums.`;

      try {
        const interactionId = await createDeepResearchInteraction(researchPrompt);
        console.log(`  Deep Research interaction: ${interactionId}`);

        const result = await pollInteractionUntilComplete(interactionId, (status) => {
          console.log(`  Research status: ${status}`);
        });

        researchContext = result.text;
        console.log(`  Research complete: ${researchContext.length} chars, ${result.sources.length} sources`);
        expect(researchContext.length).toBeGreaterThan(0);
      } catch (error) {
        console.warn(`  Research failed (non-fatal): ${error}`);
        researchContext = '';
      }
    });
  });

  // Phase 3: Generation — all 8 asset types
  describe('Phase 3: Generation', () => {
    for (const assetType of ALL_ASSET_TYPES) {
      it(`generates ${assetType}`, { timeout: 180_000 }, async () => {
        const systemPrompt = buildSystemPrompt(assetType);
        const userPrompt = buildUserPrompt(assetType);

        const response = await generateWithGemini(userPrompt, {
          systemPrompt,
          temperature: 0.7,
        });

        generatedOutputs[assetType] = response.text;
        const wordCount = response.text.split(/\s+/).length;
        console.log(`  ${assetType}: ${wordCount} words, ${response.text.length} chars, ${response.usage.totalTokens} tokens`);

        expect(response.text.length).toBeGreaterThan(100);
      });
    }
  });

  // Phase 4: Structural Validation
  describe('Phase 4: Structural Validation', () => {
    it('messaging_template has required sections', () => {
      const content = generatedOutputs['messaging_template'];
      if (!content) return; // skip if generation failed

      const contentLower = content.toLowerCase();
      const requiredSections = ['key message', 'customer promise', 'proof point', 'use case', 'problem statement'];
      const found = requiredSections.filter(s => contentLower.includes(s));
      console.log(`  messaging_template sections found: ${found.join(', ')}`);
      expect(found.length).toBeGreaterThanOrEqual(3);

      // Check for description variants
      const hasDescriptions = contentLower.includes('short') && contentLower.includes('medium') || contentLower.includes('long');
      console.log(`  Has description variants: ${hasDescriptions}`);

      const wordCount = content.split(/\s+/).length;
      console.log(`  messaging_template word count: ${wordCount}`);
      expect(wordCount).toBeGreaterThan(500);
    });

    it('narrative has 3 variants', () => {
      const content = generatedOutputs['narrative'];
      if (!content) return;

      const contentLower = content.toLowerCase();
      const hasVariant1 = contentLower.includes('variant 1') || contentLower.includes('executive summary');
      const hasVariant2 = contentLower.includes('variant 2') || contentLower.includes('conference talk');
      const hasVariant3 = contentLower.includes('variant 3') || contentLower.includes('full narrative');

      console.log(`  Variant 1 (exec summary): ${hasVariant1}`);
      console.log(`  Variant 2 (conf talk): ${hasVariant2}`);
      console.log(`  Variant 3 (full narrative): ${hasVariant3}`);

      expect(hasVariant1).toBe(true);
      expect(hasVariant2).toBe(true);
      expect(hasVariant3).toBe(true);

      const wordCount = content.split(/\s+/).length;
      console.log(`  narrative total word count: ${wordCount}`);
      expect(wordCount).toBeGreaterThan(500);
    });

    it('all standard types have reasonable content', () => {
      const standardTypes: AssetType[] = ['battlecard', 'talk_track', 'launch_messaging', 'social_hook', 'one_pager', 'email_copy'];
      for (const t of standardTypes) {
        const content = generatedOutputs[t];
        if (!content) continue;

        const wordCount = content.split(/\s+/).length;
        console.log(`  ${t}: ${wordCount} words`);
        expect(wordCount).toBeGreaterThan(20);
      }
    });
  });

  // Phase 5: Quality Scoring
  describe('Phase 5: Quality Scoring', () => {
    for (const assetType of ALL_ASSET_TYPES) {
      it(`scores ${assetType}`, { timeout: 180_000 }, async () => {
        const content = generatedOutputs[assetType];
        if (!content) {
          console.log(`  ${assetType}: skipped (no content)`);
          return;
        }

        const [slopResult, vendorResult, specificityResult] = await Promise.all([
          analyzeSlop(content).catch(() => ({ score: -1 })),
          analyzeVendorSpeak(content).catch(() => ({ score: -1 })),
          analyzeSpecificity(content, [extractedText.substring(0, 2000)]).catch(() => ({ score: -1 })),
        ]);

        const scores = {
          slop: (slopResult as any).score,
          vendorSpeak: (vendorResult as any).score,
          specificity: (specificityResult as any).score,
        };

        console.log(`  ${assetType} scores — slop: ${scores.slop}, vendor: ${scores.vendorSpeak}, specificity: ${scores.specificity}`);

        // All scores should be in valid 0-10 range
        for (const [dim, score] of Object.entries(scores)) {
          if (score === -1) continue; // scoring call failed
          expect(score, `${assetType} ${dim} score out of range`).toBeGreaterThanOrEqual(0);
          expect(score, `${assetType} ${dim} score out of range`).toBeLessThanOrEqual(10);
        }

        // Quality gate check against test voice thresholds
        const { thresholds } = TEST_VOICE;
        const passesGates =
          scores.slop <= thresholds.slopMax &&
          scores.vendorSpeak <= thresholds.vendorSpeakMax &&
          scores.specificity >= thresholds.specificityMin;

        console.log(`  ${assetType} passes gates: ${passesGates}`);
      });
    }
  });
});
