import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any vi.mock() calls
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
  mockTotalQualityScore,
  mockAnalyzeSlop,
  mockDeslop,
  mockGenerateWithGemini,
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
    mockTotalQualityScore: vi.fn(),
    mockAnalyzeSlop: vi.fn(),
    mockDeslop: vi.fn(),
    mockGenerateWithGemini: vi.fn(),
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
  totalQualityScore: mockTotalQualityScore,
  DEFAULT_THRESHOLDS: { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6 },
}));

vi.mock('../../../src/services/quality/slop-detector.js', () => ({
  analyzeSlop: mockAnalyzeSlop,
  deslop: mockDeslop,
}));

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateWithGemini: mockGenerateWithGemini,
  generateWithGeminiGroundedSearch: vi.fn(),
  createDeepResearchInteraction: vi.fn(),
  pollInteractionUntilComplete: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  config: { ai: { gemini: { proModel: 'gemini-pro' } } },
}));

vi.mock('../../../src/services/product/insights.js', () => ({
  extractInsights: vi.fn().mockResolvedValue(null),
  buildFallbackInsights: vi.fn().mockReturnValue({ summary: '', productCapabilities: [], keyDifferentiators: [], targetPersonas: [], painPointsAddressed: [], claimsAndMetrics: [], technicalDetails: [], domain: 'unknown', category: 'unknown', productType: 'unknown' }),
  formatInsightsForDiscovery: vi.fn().mockReturnValue(''),
  formatInsightsForResearch: vi.fn().mockReturnValue(''),
  formatInsightsForPrompt: vi.fn().mockReturnValue(''),
  formatInsightsForScoring: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/api/generate.js', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('system'),
  buildUserPrompt: vi.fn().mockReturnValue('user'),
  buildRefinementPrompt: vi.fn().mockReturnValue('refine'),
  loadTemplate: vi.fn().mockReturnValue('template'),
  generateContent: vi.fn().mockResolvedValue({ text: 'generated', usage: { totalTokens: 100 } }),
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

import { runAdversarialLoopAction } from '../../../src/services/workspace/actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const passingScores = {
  slopScore: 2,
  vendorSpeakScore: 2,
  authenticityScore: 8,
  specificityScore: 8,
  personaAvgScore: 8,
  slopAnalysis: { score: 2 },
};

const failingScores = {
  slopScore: 7,
  vendorSpeakScore: 7,
  authenticityScore: 3,
  specificityScore: 3,
  personaAvgScore: 3,
  slopAnalysis: { score: 7 },
};

const thresholds = { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6 };

function setupActiveVersion(content = 'original content') {
  // getActiveVersion: findMany returns versions, find the active one
  mockFindMany
    .mockResolvedValueOnce([{ id: 'v1', versionNumber: 1, isActive: true, content }])  // getActiveVersion query
    ;
  // loadSessionThresholds: findFirst returns session, then voice
  mockFindFirst
    .mockResolvedValueOnce({ id: 's1', voiceProfileId: 'vp1' })  // session
    .mockResolvedValueOnce({ id: 'vp1', scoringThresholds: JSON.stringify(thresholds) })  // voice
    ;
}

function setupCreateVersionAndActivate() {
  // getNextVersionNumber: findMany returns existing versions
  mockFindMany
    .mockResolvedValueOnce([{ versionNumber: 1 }])   // getNextVersionNumber
    .mockResolvedValueOnce([])                         // active versions to deactivate
    ;
  mockFindFirst.mockResolvedValueOnce({ id: 'test-id-123', versionNumber: 2 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('runAdversarialLoopAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeslop.mockResolvedValue('deslopped content');
    mockGenerateWithGemini.mockResolvedValue({ text: 'refined content', usage: { totalTokens: 50 } });
  });

  it('terminates immediately when gates pass on first score', async () => {
    setupActiveVersion();
    mockScoreContent.mockResolvedValue(passingScores);
    mockCheckQualityGates.mockReturnValue(true);
    setupCreateVersionAndActivate();

    await runAdversarialLoopAction('s1', 'battlecard');

    // scoreContent called once (initial), no iterations
    expect(mockScoreContent).toHaveBeenCalledTimes(1);
    expect(mockDeslop).not.toHaveBeenCalled();
    expect(mockGenerateWithGemini).not.toHaveBeenCalled();

    // Version stored with iterations: 0
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'adversarial',
        sourceDetail: expect.stringContaining('"iterations":0'),
      })
    );
  });

  it('runs max 3 iterations when gates never pass', async () => {
    setupActiveVersion();
    mockScoreContent.mockResolvedValue(failingScores);
    mockCheckQualityGates.mockReturnValue(false);
    setupCreateVersionAndActivate();

    await runAdversarialLoopAction('s1', 'battlecard');

    // 1 initial + 3 re-scores = 4 total calls
    expect(mockScoreContent).toHaveBeenCalledTimes(4);

    // Version stored with iterations: 3
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDetail: expect.stringContaining('"iterations":3'),
      })
    );
  });

  it('terminates early when gates pass mid-loop', async () => {
    setupActiveVersion();
    // First score fails, second (after 1 iteration) passes
    mockScoreContent
      .mockResolvedValueOnce(failingScores)   // initial
      .mockResolvedValueOnce(passingScores);  // after iteration 1
    mockCheckQualityGates
      .mockReturnValueOnce(false)   // initial check
      .mockReturnValueOnce(true);   // after iteration 1
    setupCreateVersionAndActivate();

    await runAdversarialLoopAction('s1', 'battlecard');

    // 1 initial + 1 re-score = 2 total
    expect(mockScoreContent).toHaveBeenCalledTimes(2);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDetail: expect.stringContaining('"iterations":1'),
      })
    );
  });

  it('breaks on generateWithGemini error', async () => {
    setupActiveVersion();
    mockScoreContent.mockResolvedValue(failingScores);
    mockCheckQualityGates.mockReturnValue(false);
    mockGenerateWithGemini.mockRejectedValue(new Error('API failed'));
    setupCreateVersionAndActivate();

    // Should not throw — the catch block absorbs it
    await runAdversarialLoopAction('s1', 'battlecard');

    // Only 1 initial score (breaks after generation error, no re-score)
    expect(mockScoreContent).toHaveBeenCalledTimes(1);
  });

  it('skips deslop when slopScore <= threshold', async () => {
    setupActiveVersion();
    const lowSlopFailing = {
      ...failingScores,
      slopScore: 4,  // below slopMax of 5
      slopAnalysis: { score: 4 },
    };
    mockScoreContent
      .mockResolvedValueOnce(lowSlopFailing)
      .mockResolvedValueOnce(passingScores);
    mockCheckQualityGates
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    setupCreateVersionAndActivate();

    await runAdversarialLoopAction('s1', 'battlecard');

    expect(mockDeslop).not.toHaveBeenCalled();
  });

  it('calls deslop when slopScore > threshold', async () => {
    setupActiveVersion();
    mockScoreContent
      .mockResolvedValueOnce(failingScores)   // slopScore: 7 > slopMax: 5
      .mockResolvedValueOnce(passingScores);
    mockCheckQualityGates
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    setupCreateVersionAndActivate();

    await runAdversarialLoopAction('s1', 'battlecard');

    expect(mockDeslop).toHaveBeenCalledWith('original content', failingScores.slopAnalysis);
  });

  it('creates version with correct source and sourceDetail', async () => {
    setupActiveVersion();
    mockScoreContent.mockResolvedValue(passingScores);
    mockCheckQualityGates.mockReturnValue(true);
    setupCreateVersionAndActivate();

    await runAdversarialLoopAction('s1', 'battlecard');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'adversarial',
      })
    );
    const sourceDetail = JSON.parse(mockInsertValues.mock.calls[0][0].sourceDetail);
    expect(sourceDetail).toHaveProperty('iterations');
    expect(sourceDetail).toHaveProperty('finalScores');
  });
});
