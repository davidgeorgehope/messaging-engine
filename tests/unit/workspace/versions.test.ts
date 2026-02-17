import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindMany,
  mockFindFirst,
  mockInsertValues,
  mockInsert,
  mockUpdateSet,
  mockUpdate,
  mockScoreContent,
  mockCheckQualityGates,
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
  };
});

vi.mock('../../../src/db/index.js', () => ({
  getDatabase: () => ({
    query: {
      sessionVersions: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
      },
      messagingAssets: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      assetVariants: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    insert: mockInsert,
    update: mockUpdate,
  }),
}));

vi.mock('../../../src/db/schema.js', () => ({
  sessionVersions: { sessionId: 'sessionId', assetType: 'assetType', versionNumber: 'versionNumber', isActive: 'isActive', id: 'id' },
  sessions: {},
  messagingAssets: { jobId: 'jobId', id: 'id' },
  assetVariants: { assetId: 'assetId' },
}));

vi.mock('../../../src/utils/hash.js', () => ({
  generateId: () => 'test-id-123',
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/services/quality/score-content.js', () => ({
  scoreContent: mockScoreContent,
  checkQualityGates: mockCheckQualityGates,
  DEFAULT_THRESHOLDS: {
    slopMax: 5,
    vendorSpeakMax: 5,
    authenticityMin: 6,
    specificityMin: 6,
    personaMin: 6,
    narrativeArcMin: 5,
  },
}));

// Drizzle ORM operators — return the args so mocks can match
vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ op: 'eq', args }),
  and: (...args: any[]) => ({ op: 'and', args }),
  desc: (col: any) => ({ op: 'desc', col }),
  inArray: (...args: any[]) => ({ op: 'inArray', args }),
}));

import { createEditVersion } from '../../../src/services/workspace/versions.js';

describe('createEditVersion', () => {
  const fakeScores = {
    slopScore: 3,
    vendorSpeakScore: 2,
    authenticityScore: 7,
    specificityScore: 8,
    personaAvgScore: 7.5,
    narrativeArcScore: 6,
    slopAnalysis: { score: 3 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockScoreContent.mockResolvedValue(fakeScores);
    mockCheckQualityGates.mockReturnValue(true);
  });

  it('should call scoreContent with the provided content', async () => {
    // No existing versions
    mockFindMany
      .mockResolvedValueOnce([])   // existing versions query
      .mockResolvedValueOnce([]);  // active versions query
    mockFindFirst.mockResolvedValue({ id: 'test-id-123', versionNumber: 1 });

    await createEditVersion('session-1', 'battlecard', 'My new content');

    expect(mockScoreContent).toHaveBeenCalledOnce();
    expect(mockScoreContent).toHaveBeenCalledWith('My new content');
  });

  it('should pass score values through to the insert call', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindFirst.mockResolvedValue({ id: 'test-id-123' });

    await createEditVersion('session-1', 'battlecard', 'Content');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slopScore: 3,
        vendorSpeakScore: 2,
        authenticityScore: 7,
        specificityScore: 8,
        personaAvgScore: 7.5,
        passesGates: true,
      })
    );
  });

  it('should increment version number from existing versions', async () => {
    // Existing version with number 3
    mockFindMany
      .mockResolvedValueOnce([{ versionNumber: 3 }])  // existing versions
      .mockResolvedValueOnce([]);                       // active versions
    mockFindFirst.mockResolvedValue({ id: 'test-id-123', versionNumber: 4 });

    await createEditVersion('session-1', 'battlecard', 'Content');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        versionNumber: 4,
      })
    );
  });

  it('should start at version 1 when no existing versions', async () => {
    mockFindMany
      .mockResolvedValueOnce([])   // no existing versions
      .mockResolvedValueOnce([]);  // no active versions
    mockFindFirst.mockResolvedValue({ id: 'test-id-123', versionNumber: 1 });

    await createEditVersion('session-1', 'battlecard', 'Content');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        versionNumber: 1,
      })
    );
  });

  it('should deactivate existing active versions before inserting', async () => {
    const activeVersion = { id: 'old-version-id', isActive: true };
    mockFindMany
      .mockResolvedValueOnce([{ versionNumber: 1 }])  // existing versions
      .mockResolvedValueOnce([activeVersion]);          // active versions
    mockFindFirst.mockResolvedValue({ id: 'test-id-123' });

    await createEditVersion('session-1', 'battlecard', 'Content');

    // Verify deactivation happened (update was called)
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith({ isActive: false });
  });

  it('should set source to "edit" and isActive to true', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindFirst.mockResolvedValue({ id: 'test-id-123' });

    await createEditVersion('session-1', 'battlecard', 'Content');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'edit',
        isActive: true,
        sessionId: 'session-1',
        assetType: 'battlecard',
        content: 'Content',
      })
    );
  });

  it('should use checkQualityGates result for passesGates', async () => {
    mockCheckQualityGates.mockReturnValue(false);
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindFirst.mockResolvedValue({ id: 'test-id-123' });

    await createEditVersion('session-1', 'battlecard', 'Low quality content');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        passesGates: false,
      })
    );
  });
});
