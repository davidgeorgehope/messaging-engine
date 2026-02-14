// Integrated E2E pipeline test
// Seeds the database and runs the full runGenerationJob() pipeline,
// then verifies messaging assets, variants, traceability, and quality scores.
// Requires ANTHROPIC_API_KEY and GOOGLE_AI_API_KEY in environment.

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/db/index.js';
import {
  messagingPriorities,
  discoveredPainPoints,
  productDocuments,
  generationJobs,
  messagingAssets,
  assetVariants,
  assetTraceability,
} from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createGenerationJob, runGenerationJob } from '../../src/services/generation/orchestrator.js';

// ---------------------------------------------------------------------------
// Test seed data — deterministic IDs for idempotent seeding
// ---------------------------------------------------------------------------
const TEST_PRIORITY_ID = 'test-e2e-priority';
const TEST_PAIN_POINT_ID = 'test-e2e-painpoint';
const TEST_PRODUCT_DOC_ID = 'test-e2e-productdoc';

const SEED_PRIORITY = {
  id: TEST_PRIORITY_ID,
  name: 'Observability Pipeline Simplification',
  slug: 'o11y-pipeline-simplification',
  description: 'Reducing complexity in observability data pipelines',
  keywords: JSON.stringify(['observability', 'pipeline', 'logs', 'metrics', 'OTel', 'data volume']),
  productContext: 'Log analytics and observability platform',
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SEED_PAIN_POINT = {
  id: TEST_PAIN_POINT_ID,
  priorityId: TEST_PRIORITY_ID,
  sourceType: 'reddit',
  sourceUrl: 'https://reddit.com/r/sre/test-post',
  sourceId: 'test-reddit-post-1',
  title: 'Spending more time maintaining log pipelines than actually debugging production issues',
  content: `Our team of 5 SREs spends roughly 40% of our time just keeping our logging pipeline running.
We have Fluentd → Kafka → Logstash → Elasticsearch, and every week something breaks.
Last month we lost 6 hours of logs during a critical outage because a Kafka partition rebalance failed silently.
The irony of your observability stack being the thing you can't observe is not lost on us.
We've looked at switching to OTel Collector but the migration path is terrifying given our 200+ services.`,
  author: 'frustrated_sre_42',
  authorLevel: 'senior',
  metadata: JSON.stringify({ subreddit: 'sre', upvotes: 342, commentCount: 89 }),
  painScore: 0.92,
  painAnalysis: JSON.stringify({
    severity: 'high',
    keywords: ['log pipeline', 'observability', 'Fluentd', 'Kafka', 'Elasticsearch', 'OTel', 'migration'],
    category: 'operational_overhead',
  }),
  practitionerQuotes: JSON.stringify([
    'We spend 40% of our time just keeping our logging pipeline running',
    'We lost 6 hours of logs during a critical outage because a Kafka partition rebalance failed silently',
    'The irony of your observability stack being the thing you can\'t observe is not lost on us',
  ]),
  status: 'pending',
  contentHash: 'test-hash-abc123',
  discoveredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SEED_PRODUCT_DOC = {
  id: TEST_PRODUCT_DOC_ID,
  name: 'Product Overview — Log Analytics Platform',
  description: 'Core product documentation covering log ingestion, search, and AI-powered analysis',
  content: `# Log Analytics Platform

## Overview
A cloud-native log analytics platform that ingests, indexes, and analyzes log data at scale.

## Key Capabilities
- **Direct Ingestion**: Accept logs via OTel, Fluentd, syslog, HTTP — no intermediate queues needed
- **Schemaless Indexing**: Automatic field extraction and indexing without predefined schemas
- **AI-Powered Streams**: Machine learning models that surface significant events from log noise
- **Sub-second Search**: Full-text search across petabytes of log data in under 1 second
- **Pipeline Elimination**: Replace Kafka → Logstash → ES chains with a single destination

## Differentiators
- 10x lower TCO than self-managed ELK stacks
- Zero pipeline maintenance — send logs directly
- OpenTelemetry native — works with existing OTel instrumentation
- Automatic pattern detection reduces alert fatigue by 80%

## Target Audience
SRE teams, platform engineers, and DevOps practitioners managing complex observability stacks.`,
  documentType: 'product_overview',
  tags: JSON.stringify(['observability', 'logs', 'pipeline', 'OTel', 'AI', 'search']),
  isActive: true,
  uploadedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Integrated Pipeline E2E', () => {
  let jobId: string;

  beforeAll(async () => {
    await initializeDatabase();
    const db = getDatabase();

    // Seed test data with onConflictDoNothing for idempotency
    await db.insert(messagingPriorities).values(SEED_PRIORITY).onConflictDoNothing();
    await db.insert(discoveredPainPoints).values(SEED_PAIN_POINT).onConflictDoNothing();
    await db.insert(productDocuments).values(SEED_PRODUCT_DOC).onConflictDoNothing();

    // Reset pain point status in case of previous run
    await db.update(discoveredPainPoints)
      .set({ status: 'pending', updatedAt: new Date().toISOString() })
      .where(eq(discoveredPainPoints.id, TEST_PAIN_POINT_ID));
  });

  it('creates a generation job', { timeout: 30_000 }, async () => {
    jobId = await createGenerationJob(TEST_PAIN_POINT_ID);
    expect(jobId).toBeTruthy();

    const db = getDatabase();
    const job = await db.query.generationJobs.findFirst({
      where: eq(generationJobs.id, jobId),
    });

    expect(job).toBeTruthy();
    expect(job!.status).toBe('pending');
    expect(job!.painPointId).toBe(TEST_PAIN_POINT_ID);
    expect(job!.priorityId).toBe(TEST_PRIORITY_ID);

    console.log(`  Job created: ${jobId}`);
  });

  it('runs the full generation pipeline', { timeout: 600_000 }, async () => {
    expect(jobId).toBeTruthy();
    await runGenerationJob(jobId);

    const db = getDatabase();
    const job = await db.query.generationJobs.findFirst({
      where: eq(generationJobs.id, jobId),
    });

    expect(job).toBeTruthy();
    expect(job!.status).toBe('completed');
    expect(job!.progress).toBe(100);

    console.log(`  Job completed: ${jobId}`);
  });

  it('creates messaging assets with content and scores', { timeout: 10_000 }, async () => {
    const db = getDatabase();
    const assets = await db.query.messagingAssets.findMany({
      where: eq(messagingAssets.jobId, jobId),
    });

    expect(assets.length).toBeGreaterThan(0);
    console.log(`  Assets created: ${assets.length}`);

    for (const asset of assets) {
      expect(asset.content.length).toBeGreaterThan(0);
      expect(asset.slopScore).not.toBeNull();
      expect(asset.vendorSpeakScore).not.toBeNull();
      expect(asset.specificityScore).not.toBeNull();
      expect(asset.personaAvgScore).not.toBeNull();
      expect(['draft', 'review']).toContain(asset.status);
      console.log(`    ${asset.assetType}: status=${asset.status}, slop=${asset.slopScore}, vendor=${asset.vendorSpeakScore}, specificity=${asset.specificityScore}, persona=${asset.personaAvgScore}`);
    }
  });

  it('creates asset variants with all 5 quality scores', { timeout: 10_000 }, async () => {
    const db = getDatabase();
    const assets = await db.query.messagingAssets.findMany({
      where: eq(messagingAssets.jobId, jobId),
    });

    for (const asset of assets) {
      const variants = await db.query.assetVariants.findMany({
        where: eq(assetVariants.assetId, asset.id),
      });

      expect(variants.length).toBeGreaterThan(0);

      for (const variant of variants) {
        expect(variant.slopScore).not.toBeNull();
        expect(variant.vendorSpeakScore).not.toBeNull();
        expect(variant.authenticityScore).not.toBeNull();
        expect(variant.specificityScore).not.toBeNull();
        expect(variant.personaAvgScore).not.toBeNull();

        // All scores should be in 0-10 range
        expect(variant.slopScore!).toBeGreaterThanOrEqual(0);
        expect(variant.slopScore!).toBeLessThanOrEqual(10);
        expect(variant.vendorSpeakScore!).toBeGreaterThanOrEqual(0);
        expect(variant.vendorSpeakScore!).toBeLessThanOrEqual(10);
        expect(variant.authenticityScore!).toBeGreaterThanOrEqual(0);
        expect(variant.authenticityScore!).toBeLessThanOrEqual(10);
        expect(variant.specificityScore!).toBeGreaterThanOrEqual(0);
        expect(variant.specificityScore!).toBeLessThanOrEqual(10);
        expect(variant.personaAvgScore!).toBeGreaterThanOrEqual(0);
        expect(variant.personaAvgScore!).toBeLessThanOrEqual(10);

        console.log(`    variant #${variant.variantNumber}: slop=${variant.slopScore}, vendor=${variant.vendorSpeakScore}, auth=${variant.authenticityScore}, spec=${variant.specificityScore}, persona=${variant.personaAvgScore}, passes=${variant.passesGates}`);
      }
    }
  });

  it('creates traceability records with painPointId and productDocId', { timeout: 10_000 }, async () => {
    const db = getDatabase();
    const assets = await db.query.messagingAssets.findMany({
      where: eq(messagingAssets.jobId, jobId),
    });

    for (const asset of assets) {
      const traces = await db.query.assetTraceability.findMany({
        where: eq(assetTraceability.assetId, asset.id),
      });

      expect(traces.length).toBeGreaterThan(0);

      for (const trace of traces) {
        expect(trace.painPointId).toBe(TEST_PAIN_POINT_ID);
        expect(trace.practitionerQuotes).toBeTruthy();

        const quotes = JSON.parse(trace.practitionerQuotes);
        expect(quotes.length).toBeGreaterThan(0);

        console.log(`    traceability: painPointId=${trace.painPointId}, researchId=${trace.researchId ?? 'null'}, productDocId=${trace.productDocId ?? 'null'}`);
      }

      // At least one trace should have the product doc ID
      const withProductDoc = traces.filter(t => t.productDocId === TEST_PRODUCT_DOC_ID);
      expect(withProductDoc.length).toBeGreaterThan(0);
    }
  });

  it('updates pain point status to completed', { timeout: 10_000 }, async () => {
    const db = getDatabase();
    const painPoint = await db.query.discoveredPainPoints.findFirst({
      where: eq(discoveredPainPoints.id, TEST_PAIN_POINT_ID),
    });

    expect(painPoint).toBeTruthy();
    expect(painPoint!.status).toBe('completed');

    console.log(`  Pain point status: ${painPoint!.status}`);
  });
});
