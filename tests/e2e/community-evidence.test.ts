// Test: community evidence search should NEVER return empty for known problem domains
// Set test profile BEFORE any imports
process.env.MODEL_PROFILE = 'test';

import { describe, it, expect, beforeAll } from 'vitest';
import { runCommunityDeepResearch } from '../../src/services/pipeline/evidence.js';
import { extractInsights, buildFallbackInsights } from '../../src/services/product/insights.js';
import { initializeDatabase } from '../../src/db/index.js';
import type { ExtractedInsights } from '../../src/services/product/insights.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const ONE_WORKFLOW_PDF = join(process.cwd(), 'data', 'uploads', 'mllhgsii-d39o46w3_One_Workflow__1_.pdf');

describe('Community Evidence Search', () => {
  let pdfText: string;
  let insights: ExtractedInsights;

  beforeAll(async () => {
    await initializeDatabase();

    // Extract PDF text the same way the pipeline does
    const { PDFParse } = await import("pdf-parse");
    const buffer = readFileSync(ONE_WORKFLOW_PDF);
    const parser = new PDFParse({ data: buffer } as any);
    const parsed = await parser.getText();
    pdfText = parsed.text;
    console.log(`PDF text: ${pdfText.length} chars`);

    // Extract insights
    const extracted = await extractInsights(pdfText);
    insights = extracted ?? buildFallbackInsights(pdfText);
    console.log(`Insights domain: ${insights.domain}/${insights.category}`);
    console.log(`Insights summary: ${insights.summary?.substring(0, 200)}`);
  }, 120000);

  it('finds community evidence for workflow automation pain', async () => {
    const evidence = await runCommunityDeepResearch(insights);

    console.log(`Evidence level: ${evidence.evidenceLevel}`);
    console.log(`Source URLs: ${evidence.communityPostCount}`);
    console.log(`Context text length: ${evidence.communityContextText.length}`);
    console.log(`Source counts:`, evidence.sourceCounts);

    // The whole point: community pain about SOAR/workflow fragmentation EXISTS
    expect(evidence.evidenceLevel).not.toBe('product-only');
    expect(evidence.communityPostCount).toBeGreaterThan(0);
    expect(evidence.communityContextText.length).toBeGreaterThan(100);
  }, 120000);

  it('finds evidence even with fallback insights', async () => {
    // Simulate extraction failure — use fallback insights
    const fallback = buildFallbackInsights(pdfText);
    console.log(`Fallback domain: ${fallback.domain}/${fallback.category}`);
    console.log(`Fallback summary: ${fallback.summary?.substring(0, 200)}`);

    const evidence = await runCommunityDeepResearch(fallback);

    console.log(`Fallback evidence level: ${evidence.evidenceLevel}`);
    console.log(`Fallback source URLs: ${evidence.communityPostCount}`);

    // Even with degraded insights, should find SOMETHING
    expect(evidence.communityContextText.length).toBeGreaterThan(0);
  }, 120000);

  it('finds evidence with explicit prompt override', async () => {
    const evidence = await runCommunityDeepResearch(
      insights,
      'Focus on SOAR tool fragmentation and the pain of having separate SIEM, observability, and automation platforms'
    );

    console.log(`Prompted evidence level: ${evidence.evidenceLevel}`);
    console.log(`Prompted source URLs: ${evidence.communityPostCount}`);

    expect(evidence.evidenceLevel).not.toBe('product-only');
    expect(evidence.communityPostCount).toBeGreaterThan(0);
  }, 120000);
});
