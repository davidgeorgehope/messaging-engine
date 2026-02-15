// E2E tests for all 5 pipelines using MODEL_PROFILE=test (Gemini Flash for everything)
// Run with: npm run test:e2e

// Set test profile BEFORE any imports
process.env.MODEL_PROFILE = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

// DB
import { initializeDatabase, getDatabase, closeDatabase } from '../../src/db/index.js';
import { generationJobs, messagingAssets, assetVariants, assetTraceability, voiceProfiles } from '../../src/db/schema.js';
import { PUBLIC_GENERATION_PRIORITY_ID } from '../../src/db/seed.js';

// Pipeline runner
import { runPublicGenerationJob } from '../../src/api/generate.js';

// Utils
import { generateId } from '../../src/utils/hash.js';

// Verify test profile is active
import { getActiveModelProfile, getModelForTask } from '../../src/config.js';

const TEST_PRODUCT_DOCS = `
AcmeDeploy is a deployment automation platform for DevOps teams.
It reduces deployment time from hours to minutes using intelligent rollback detection.
Key features: zero-downtime deployments, automatic canary analysis, integration with
Kubernetes and AWS ECS, real-time deployment health scoring.
Practitioners currently struggle with manual deployment scripts, lack of rollback
confidence, and no visibility into deployment health across microservices.
AcmeDeploy monitors 47 health signals during each deployment, automatically triggers
rollback if error rates exceed baseline by 2x, and provides a unified dashboard
showing deployment status across all services. Teams using AcmeDeploy report 73%
fewer failed deployments and 89% faster mean-time-to-recovery.
`;

const TEST_EXISTING_MESSAGING = `
# AcmeDeploy: Stop Deploying Blind

Every deployment is a coin flip. You push code, hold your breath, and watch Slack
for the inevitable "something's broken" message. Your rollback script hasn't been
tested since the last incident (which was caused by the rollback script).

AcmeDeploy monitors 47 health signals during each deployment. If error rates spike
past 2x baseline, it rolls back automatically — no human panic required. Teams see
73% fewer failed deployments within the first month.

The difference between AcmeDeploy and your current deploy script: AcmeDeploy actually
works at 3am when nobody's watching.
`;

let testVoiceId: string;

async function createTestJob(pipeline: string, opts: { existingMessaging?: string } = {}): Promise<string> {
  const db = getDatabase();
  const jobId = generateId();
  const now = new Date().toISOString();

  await db.insert(generationJobs).values({
    id: jobId,
    status: 'pending',
    currentStep: 'Queued',
    progress: 0,
    productContext: JSON.stringify({
      productDocs: TEST_PRODUCT_DOCS,
      existingMessaging: opts.existingMessaging,
      voiceProfileIds: [testVoiceId],
      assetTypes: ['battlecard'],  // single asset type for speed
      model: 'gemini-2.0-flash',
      pipeline,
    }),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return jobId;
}

async function getJobResult(jobId: string) {
  const db = getDatabase();
  const job = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, jobId),
  });
  const assets = await db.query.messagingAssets.findMany({
    where: eq(messagingAssets.jobId, jobId),
  });
  const traceability = assets.length > 0
    ? await db.query.assetTraceability.findMany({
        where: eq(assetTraceability.assetId, assets[0].id),
      })
    : [];
  return { job, assets, traceability };
}

describe('All 5 Pipelines E2E (Flash model profile)', () => {
  beforeAll(async () => {
    expect(getActiveModelProfile()).toBe('test');
    console.log(`\n🛡️  MODEL_PROFILE=${getActiveModelProfile()} — all calls using: ${getModelForTask('flash')}\n`);
    await initializeDatabase();

    // Get first active voice profile
    const db = getDatabase();
    const voices = await db.query.voiceProfiles.findMany({
      where: eq(voiceProfiles.isActive, true),
    });
    expect(voices.length).toBeGreaterThan(0);
    testVoiceId = voices[0].id;
    console.log(`Using voice: ${voices[0].name} (${testVoiceId})`);
  });

  afterAll(() => {
    closeDatabase();
  });

  it('straight-through pipeline: scores existing content without generation', async () => {
    const jobId = await createTestJob('straight-through', { existingMessaging: TEST_EXISTING_MESSAGING });
    await runPublicGenerationJob(jobId);

    const { job, assets, traceability } = await getJobResult(jobId);

    expect(job?.status).toBe('completed');
    expect(job?.progress).toBe(100);
    expect(assets.length).toBeGreaterThanOrEqual(1);

    // Content should be identical to input (no generation)
    expect(assets[0].content).toBe(TEST_EXISTING_MESSAGING);

    // Scores should be populated
    expect(assets[0].slopScore).not.toBeNull();
    expect(assets[0].specificityScore).not.toBeNull();

    // Traceability should exist
    expect(traceability.length).toBeGreaterThanOrEqual(1);

    console.log(`  Straight-through: scores=${JSON.stringify({
      slop: assets[0].slopScore,
      vendor: assets[0].vendorSpeakScore,
      specificity: assets[0].specificityScore,
    })}`);
  }, 120_000);

  it('standard pipeline: full DAG with PoV extraction', async () => {
    const jobId = await createTestJob('standard');
    await runPublicGenerationJob(jobId);

    const { job, assets, traceability } = await getJobResult(jobId);

    expect(job?.status).toBe('completed');
    expect(job?.progress).toBe(100);
    expect(assets.length).toBeGreaterThanOrEqual(1);

    // Content should be generated (not empty)
    expect(assets[0].content.length).toBeGreaterThan(100);

    // Scores should be populated
    expect(assets[0].slopScore).not.toBeNull();
    expect(assets[0].specificityScore).not.toBeNull();

    // Traceability
    expect(traceability.length).toBeGreaterThanOrEqual(1);

    // Check pipeline steps were recorded
    const steps = JSON.parse(job?.pipelineSteps || '[]');
    const stepNames = steps.map((s: any) => s.step);
    expect(stepNames).toContain('deep-pov-extraction');

    console.log(`  Standard: ${assets[0].content.length} chars, steps=${stepNames.join(',')}`);
  }, 600_000);

  it('outside-in pipeline: community-first sequential DAG', async () => {
    const jobId = await createTestJob('outside-in');
    await runPublicGenerationJob(jobId);

    const { job, assets, traceability } = await getJobResult(jobId);

    expect(job?.status).toBe('completed');
    expect(job?.progress).toBe(100);
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets[0].content.length).toBeGreaterThan(100);

    // Scores populated
    expect(assets[0].slopScore).not.toBeNull();

    // Check community research step was attempted
    const steps = JSON.parse(job?.pipelineSteps || '[]');
    const stepNames = steps.map((s: any) => s.step);
    // Either community-research ran, or it fell back to standard (which has its own steps)
    const hasCommunityStep = stepNames.includes('community-research') || stepNames.includes('deep-pov-extraction');
    expect(hasCommunityStep).toBe(true);

    console.log(`  Outside-in: ${assets[0].content.length} chars, steps=${stepNames.join(',')}`);
  }, 600_000);

  it('adversarial pipeline: 2 rounds of attack/defend', async () => {
    const jobId = await createTestJob('adversarial');
    await runPublicGenerationJob(jobId);

    const { job, assets, traceability } = await getJobResult(jobId);

    expect(job?.status).toBe('completed');
    expect(job?.progress).toBe(100);
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets[0].content.length).toBeGreaterThan(100);

    // Scores populated
    expect(assets[0].slopScore).not.toBeNull();

    // Check attack/defend steps
    const steps = JSON.parse(job?.pipelineSteps || '[]');
    const stepNames = steps.map((s: any) => s.step);
    const hasAttack = stepNames.some((s: string) => s.includes('attack'));
    const hasDefend = stepNames.some((s: string) => s.includes('defend'));
    expect(hasAttack).toBe(true);
    expect(hasDefend).toBe(true);

    console.log(`  Adversarial: ${assets[0].content.length} chars, attack/defend steps found`);
  }, 600_000);

  it('multi-perspective pipeline: 3 angles + synthesis', async () => {
    const jobId = await createTestJob('multi-perspective');
    await runPublicGenerationJob(jobId);

    const { job, assets, traceability } = await getJobResult(jobId);

    expect(job?.status).toBe('completed');
    expect(job?.progress).toBe(100);
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets[0].content.length).toBeGreaterThan(100);

    // Scores populated
    expect(assets[0].slopScore).not.toBeNull();

    // Check perspective + synthesis steps
    const steps = JSON.parse(job?.pipelineSteps || '[]');
    const stepNames = steps.map((s: any) => s.step);
    const hasPerspectives = stepNames.some((s: string) => s.includes('perspectives'));
    const hasSynthesize = stepNames.some((s: string) => s.includes('synthesize'));
    expect(hasPerspectives).toBe(true);
    expect(hasSynthesize).toBe(true);

    console.log(`  Multi-perspective: ${assets[0].content.length} chars, perspectives+synthesis found`);
  }, 600_000);
});
