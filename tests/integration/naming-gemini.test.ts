import { describe, it, expect } from 'vitest';
import { generateWithGemini } from '../../src/services/ai/clients.js';

// This test reproduces the exact naming prompt that returned empty from Gemini
// on 2026-02-14T23:31:19. Uses the real Gemini API — no mocks.

const TOPIC = "One Workflow is Elastic's native automation engine that integrates workflow capabilities across Security and Observability";
const DOMAIN_INFO = 'Security and Observability / Workflow Automation / SOAR / AIOps / SaaS platform';
const ASSET_TYPE_LABELS = 'Narrative';

describe('naming prompt — real Gemini call', () => {
  // The exact prompt that returned empty (old version with "Do NOT")
  it('should reproduce the failing prompt (aggressive "Do NOT" version)', async () => {
    const prompt = `Generate a concise 3-6 word name for a messaging session.\nTopic: ${TOPIC}\nDomain: ${DOMAIN_INFO}\nAsset types: ${ASSET_TYPE_LABELS}\nIMPORTANT: Do NOT use brand/company/product names. Focus on the functional domain — what the product DOES, not what it's called.\nExamples: 'Log Pipeline Cost Battlecard', 'Workflow Automation Narrative', 'Alert Fatigue Launch Pack', 'SOAR Integration Messaging Suite'\nReturn ONLY the name, no quotes.`;

    console.log('\n=== PROMPT (old, aggressive) ===');
    console.log(prompt);

    const result = await generateWithGemini(prompt, {
      temperature: 0.3,
      maxTokens: 50,
    });

    console.log('\n=== RESPONSE ===');
    console.log('text:', JSON.stringify(result.text));
    console.log('finishReason:', result.finishReason);
    console.log('usage:', result.usage);

    // This is what we're investigating — did it return empty?
    expect(result.text.length).toBeGreaterThan(0);
  }, 15000);

  // The softened version
  it('should work with the softened prompt', async () => {
    const prompt = `Generate a concise 3-6 word name for a messaging session about this topic.\nTopic: ${TOPIC}\nDomain: ${DOMAIN_INFO}\nAsset types: ${ASSET_TYPE_LABELS}\nUse the functional domain (what the product does), not brand names.\nExamples: 'Log Pipeline Cost Battlecard', 'Workflow Automation Narrative', 'Alert Fatigue Launch Pack', 'SOAR Integration Messaging'\nReturn ONLY the name, nothing else.`;

    console.log('\n=== PROMPT (softened) ===');
    console.log(prompt);

    const result = await generateWithGemini(prompt, {
      temperature: 0.3,
      maxTokens: 50,
    });

    console.log('\n=== RESPONSE ===');
    console.log('text:', JSON.stringify(result.text));
    console.log('finishReason:', result.finishReason);
    console.log('usage:', result.usage);

    expect(result.text.length).toBeGreaterThan(0);
  }, 15000);

  // Run the old prompt 5 times to check for flakiness
  it('should be consistent across 5 runs (old prompt)', async () => {
    const prompt = `Generate a concise 3-6 word name for a messaging session.\nTopic: ${TOPIC}\nDomain: ${DOMAIN_INFO}\nAsset types: ${ASSET_TYPE_LABELS}\nIMPORTANT: Do NOT use brand/company/product names. Focus on the functional domain — what the product DOES, not what it's called.\nExamples: 'Log Pipeline Cost Battlecard', 'Workflow Automation Narrative', 'Alert Fatigue Launch Pack', 'SOAR Integration Messaging Suite'\nReturn ONLY the name, no quotes.`;

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await generateWithGemini(prompt, {
        temperature: 0.3,
        maxTokens: 50,
      });
      results.push(result.text);
      console.log(`Run ${i + 1}: text=${JSON.stringify(result.text)} finishReason=${result.finishReason}`);
    }

    const empties = results.filter(r => !r || r.trim().length === 0);
    console.log(`\n${empties.length}/5 empty responses`);

    // If even one is empty, we have a flakiness problem
    expect(empties.length).toBe(0);
  }, 60000);
});
