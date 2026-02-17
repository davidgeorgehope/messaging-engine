import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockFindMany,
  mockFindFirst,
  mockInsertValues,
  mockInsert,
  mockUpdateSet,
  mockUpdate,
  mockScoreContent,
  mockCheckQualityGates,
  mockAnalyzeSlop,
  mockDeslop,
} = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockReturnValue({ run: vi.fn() });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) });
  return {
    mockFindMany: vi.fn(),
    mockFindFirst: vi.fn(),
    mockInsertValues,
    mockInsert: vi.fn().mockReturnValue({ values: mockInsertValues }),
    mockUpdateSet,
    mockUpdate: vi.fn().mockReturnValue({ set: mockUpdateSet }),
    mockScoreContent: vi.fn(),
    mockCheckQualityGates: vi.fn(),
    mockAnalyzeSlop: vi.fn(),
    mockDeslop: vi.fn(),
  };
});

vi.mock('../../../src/db/index.js', () => ({
  getDatabase: () => ({
    query: {
      sessionVersions: { findMany: mockFindMany, findFirst: mockFindFirst },
      sessions: { findFirst: mockFindFirst },
      voiceProfiles: { findFirst: mockFindFirst },
      productDocuments: { findFirst: vi.fn() },
      generationJobs: { findFirst: vi.fn() },
    },
    insert: mockInsert,
    update: mockUpdate,
  }),
}));

vi.mock('../../../src/db/schema.js', () => ({
  sessionVersions: { sessionId: 'sessionId', assetType: 'assetType', versionNumber: 'versionNumber', isActive: 'isActive', id: 'id' },
  sessions: {},
  voiceProfiles: {},
  productDocuments: {},
  generationJobs: {},
}));

vi.mock('../../../src/utils/hash.js', () => ({
  generateId: () => 'test-id-123',
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/services/quality/score-content.js', () => ({
  scoreContent: mockScoreContent,
  checkQualityGates: mockCheckQualityGates,
  totalQualityScore: vi.fn(),
  DEFAULT_THRESHOLDS: { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6, narrativeArcMin: 5 },
}));

vi.mock('../../../src/services/quality/slop-detector.js', () => ({
  analyzeSlop: mockAnalyzeSlop,
  deslop: mockDeslop,
}));

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateWithGemini: vi.fn(),
  generateWithGeminiGroundedSearch: vi.fn(),
  createDeepResearchInteraction: vi.fn(),
  pollInteractionUntilComplete: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  config: { ai: { gemini: { proModel: 'gemini-pro' } } },
}));

vi.mock('../../../src/services/product/insights.js', () => ({
  extractInsights: vi.fn(),
  buildFallbackInsights: vi.fn(),
  formatInsightsForDiscovery: vi.fn(),
  formatInsightsForResearch: vi.fn(),
  formatInsightsForPrompt: vi.fn(),
  formatInsightsForScoring: vi.fn(),
}));

vi.mock('../../../src/api/generate.js', () => ({
  buildSystemPrompt: vi.fn(),
  buildUserPrompt: vi.fn(),
  buildRefinementPrompt: vi.fn(),
  loadTemplate: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock('../../../src/services/research/deep-research.js', () => ({
  createDeepResearchInteraction: vi.fn(),
  pollInteractionUntilComplete: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ op: 'eq', args }),
  and: (...args: any[]) => ({ op: 'and', args }),
  desc: (col: any) => ({ op: 'desc', col }),
}));

import { runDeslopAction } from '../../../src/services/workspace/actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeScores = {
  slopScore: 2,
  vendorSpeakScore: 3,
  authenticityScore: 8,
  specificityScore: 7,
  personaAvgScore: 7.5,
  narrativeArcScore: 6,
  slopAnalysis: { score: 2 },
};

const thresholds = { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6, narrativeArcMin: 5 };

describe('createVersionAndActivate (via runDeslopAction)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnalyzeSlop.mockResolvedValue({ score: 4, matches: [] });
    mockDeslop.mockResolvedValue('deslopped content');
    mockScoreContent.mockResolvedValue(fakeScores);
  });

  function setupForDeslop(existingVersions: any[] = [], activeVersions: any[] = []) {
    // getActiveVersion: findMany returns versions list
    mockFindMany.mockResolvedValueOnce(
      existingVersions.length > 0
        ? existingVersions
        : [{ id: 'v1', versionNumber: 1, isActive: true, content: 'original' }],
    );
    // loadSessionThresholds: findFirst returns session then voice
    mockFindFirst
      .mockResolvedValueOnce({ id: 's1', voiceProfileId: 'vp1' })
      .mockResolvedValueOnce({ id: 'vp1', scoringThresholds: JSON.stringify(thresholds) });
    // getNextVersionNumber: findMany returns existing versions
    mockFindMany.mockResolvedValueOnce(
      existingVersions.length > 0 ? existingVersions : [{ versionNumber: 1 }],
    );
    // active versions to deactivate
    mockFindMany.mockResolvedValueOnce(activeVersions);
    // final findFirst after insert
    mockFindFirst.mockResolvedValueOnce({ id: 'test-id-123', versionNumber: 2 });
  }

  it('deactivates multiple existing active versions', async () => {
    const activeV1 = { id: 'v1', isActive: true, versionNumber: 1, content: 'original' };
    const activeV2 = { id: 'v2', isActive: true, versionNumber: 2, content: 'original' };
    setupForDeslop(
      [activeV1, activeV2],  // existing versions (getActiveVersion picks first isActive)
      [activeV1, activeV2],  // active versions to deactivate
    );

    await runDeslopAction('s1', 'battlecard');

    // update called once for each active version
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdateSet).toHaveBeenCalledWith({ isActive: false });
  });

  it('increments version number from max existing', async () => {
    setupForDeslop(
      [{ id: 'v3', versionNumber: 3, isActive: true, content: 'original' }],
      [],
    );

    await runDeslopAction('s1', 'battlecard');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ versionNumber: 4 }),
    );
  });

  it('persists all 5 quality scores', async () => {
    setupForDeslop();
    mockCheckQualityGates.mockReturnValue(true);

    await runDeslopAction('s1', 'battlecard');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slopScore: 2,
        vendorSpeakScore: 3,
        authenticityScore: 8,
        specificityScore: 7,
        personaAvgScore: 7.5,
      }),
    );
  });

  it('sets passesGates=true when gates pass', async () => {
    setupForDeslop();
    mockCheckQualityGates.mockReturnValue(true);

    await runDeslopAction('s1', 'battlecard');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ passesGates: true }),
    );
  });

  it('sets passesGates=false when gates fail', async () => {
    setupForDeslop();
    mockCheckQualityGates.mockReturnValue(false);

    await runDeslopAction('s1', 'battlecard');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ passesGates: false }),
    );
  });

  it('stores correct source and sourceDetail', async () => {
    setupForDeslop();
    mockCheckQualityGates.mockReturnValue(true);

    await runDeslopAction('s1', 'battlecard');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'deslop',
      }),
    );
    const insertCall = mockInsertValues.mock.calls[0][0];
    const sourceDetail = JSON.parse(insertCall.sourceDetail);
    expect(sourceDetail).toHaveProperty('previousVersion');
    expect(sourceDetail).toHaveProperty('slopAnalysis');
  });
});
