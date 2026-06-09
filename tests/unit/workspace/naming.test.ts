import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateWithGemini: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: (...args: any[]) => console.log('[INFO]', ...args),
    debug: (...args: any[]) => console.log('[DEBUG]', ...args),
    warn: (...args: any[]) => console.log('[WARN]', ...args),
    error: (...args: any[]) => console.log('[ERROR]', ...args),
  }),
}));

const mockFindFirst = vi.fn();
const mockRun = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ run: mockRun });
const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

vi.mock('../../../src/db/index.js', () => ({
  getDatabase: () => ({
    query: {
      sessions: { findFirst: (...args: any[]) => mockFindFirst(...args) },
    },
    update: (...args: any[]) => mockUpdate(...args),
  }),
}));

vi.mock('../../../src/db/schema.js', () => ({
  sessions: { jobId: 'job_id', id: 'id' },
  sessionVersions: {},
  discoveredPainPoints: {},
  generationJobs: {},
  voiceProfiles: {},
  productDocuments: {},
  messagingAssets: {},
  assetVariants: {},
}));

vi.mock('../../../src/db/seed.js', () => ({
  PUBLIC_GENERATION_PRIORITY_ID: 'test-priority-id',
}));

vi.mock('../../../src/api/generate.js', () => ({
  ASSET_TYPE_LABELS: {
    narrative: 'Narrative',
    battlecard: 'Battlecard',
    'talk-track': 'Talk Track',
  },
  runPublicGenerationJob: vi.fn(),
}));

vi.mock('../../../src/utils/hash.js', () => ({
  generateId: () => 'test-id',
  hashContent: () => 'test-hash',
}));

vi.mock('./versions.js', () => ({
  createInitialVersions: vi.fn(),
}));

vi.mock('../../../src/services/workspace/versions.js', () => ({
  createInitialVersions: vi.fn(),
}));

import { generateWithGemini } from '../../../src/services/ai/clients.js';
import { nameSessionFromInsights } from '../../../src/services/workspace/sessions.js';
import type { ExtractedInsights } from '../../../src/services/product/insights.js';
import type { AssetType } from '../../../src/services/generation/types.js';

const mockedGenerate = vi.mocked(generateWithGemini);

const SAMPLE_INSIGHTS: ExtractedInsights = {
  summary: "CaseFlow is Acme's workflow automation engine that coordinates approvals, escalations, and handoffs across customer operations",
  domain: 'Customer Operations',
  category: 'Workflow Automation / Case Management',
  productType: 'SaaS platform',
  productCapabilities: ['Automated approvals', 'Cross-team handoffs', 'Workflow orchestration'],
  keyDifferentiators: ['Native integration with existing business systems'],
  targetPersonas: ['Operations leaders', 'Customer support managers', 'RevOps teams'],
  painPointsAddressed: ['Tool sprawl', 'Manual case routing'],
  claimsAndMetrics: ['50% reduction in handling time'],
  technicalDetails: ['API-first workflow engine'],
};

describe('nameSessionFromInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({ id: 'session-123', jobId: 'job-456' });
    mockRun.mockResolvedValue(undefined);
  });

  it('should pass a well-formed prompt to Gemini', async () => {
    mockedGenerate.mockResolvedValue({ text: 'Workflow Automation Narrative', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }, model: 'gemini', latencyMs: 100 });

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    const [prompt, options] = mockedGenerate.mock.calls[0];

    console.log('\n=== PROMPT SENT TO GEMINI ===');
    console.log(prompt);
    console.log('\n=== OPTIONS ===');
    console.log(JSON.stringify(options, null, 2));

    expect(prompt).toContain('Topic:');
    expect(prompt).toContain('Domain:');
    expect(prompt).toContain('Narrative');
  });

  it('should update session name when Gemini returns valid name', async () => {
    mockedGenerate.mockResolvedValue({ text: 'Workflow Automation Narrative', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }, model: 'gemini', latencyMs: 100 });

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    expect(mockSet).toHaveBeenCalled();
    const setArg = mockSet.mock.calls[0][0];
    console.log('\n=== DB UPDATE ===');
    console.log(setArg);
    expect(setArg.name).toBe('Workflow Automation Narrative');
  });

  it('should handle empty string response from Gemini', async () => {
    mockedGenerate.mockResolvedValue({ text: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }, model: 'gemini', latencyMs: 100 });

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('should handle undefined text in Gemini response', async () => {
    mockedGenerate.mockResolvedValue({ text: undefined as any, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }, model: 'gemini', latencyMs: 100 });

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('should strip quotes from Gemini response', async () => {
    mockedGenerate.mockResolvedValue({ text: "'Workflow Automation Narrative'", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }, model: 'gemini', latencyMs: 100 });

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    const setArg = mockSet.mock.calls[0][0];
    expect(setArg.name).toBe('Workflow Automation Narrative');
  });

  it('should not crash when Gemini throws', async () => {
    mockedGenerate.mockRejectedValue(new Error('rate limited'));

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('should skip when no session found for job', async () => {
    mockFindFirst.mockResolvedValue(null);

    await nameSessionFromInsights('job-456', SAMPLE_INSIGHTS, ['narrative'] as AssetType[]);

    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('should skip when insights have no useful topic', async () => {
    const emptyInsights: ExtractedInsights = {
      ...SAMPLE_INSIGHTS,
      summary: '',
      domain: 'unknown',
      category: 'unknown',
    };

    await nameSessionFromInsights('job-456', emptyInsights, ['narrative'] as AssetType[]);

    expect(mockedGenerate).not.toHaveBeenCalled();
  });
});
