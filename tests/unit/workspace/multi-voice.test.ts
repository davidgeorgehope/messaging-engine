import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindFirst,
  mockFindMany,
  mockInsertValues,
  mockInsert,
} = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockReturnValue({ run: vi.fn() });
  return {
    mockFindFirst: vi.fn(),
    mockFindMany: vi.fn(),
    mockInsertValues,
    mockInsert: vi.fn().mockReturnValue({ values: mockInsertValues }),
  };
});

vi.mock('../../../src/db/index.js', () => ({
  getDatabase: () => ({
    query: {
      sessions: { findFirst: mockFindFirst },
      voiceProfiles: { findMany: mockFindMany },
      productDocuments: { findFirst: vi.fn() },
      discoveredPainPoints: { findFirst: vi.fn() },
      generationJobs: { findFirst: vi.fn() },
    },
    insert: mockInsert,
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }) }),
  }),
}));

vi.mock('../../../src/db/schema.js', () => ({
  sessions: { id: 'id' },
  voiceProfiles: { isActive: 'isActive', id: 'id' },
  discoveredPainPoints: { id: 'id' },
  generationJobs: {},
  productDocuments: { id: 'id' },
  messagingAssets: {},
  assetVariants: {},
  assetTraceability: {},
}));

vi.mock('../../../src/db/seed.js', () => ({
  PUBLIC_GENERATION_PRIORITY_ID: 'pub-priority-id',
}));

vi.mock('../../../src/utils/hash.js', () => ({
  generateId: () => 'test-id-' + Math.random().toString(36).slice(2, 8),
  hashContent: (s: string) => 'hash-' + s.slice(0, 8),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateWithGemini: vi.fn().mockResolvedValue({ text: 'Test Session Name' }),
}));

vi.mock('../../../src/api/generate.js', () => ({
  runPublicGenerationJob: vi.fn().mockResolvedValue(undefined),
  ASSET_TYPE_LABELS: { battlecard: 'Battlecard', talk_track: 'Talk Track' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ op: 'eq', args }),
  and: (...args: any[]) => ({ op: 'and', args }),
  desc: (col: any) => ({ op: 'desc', col }),
  inArray: (...args: any[]) => ({ op: 'inArray', args }),
}));

import { createSession } from '../../../src/services/workspace/sessions.js';

describe('Multi-voice session support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({
      id: 'session-1',
      name: 'New Session',
      voiceProfileId: null,
      metadata: '{}',
      assetTypes: '["battlecard"]',
    });
  });

  describe('createSession voice storage', () => {
    it('stores voiceProfileIds in metadata when multiple voices selected', async () => {
      const input = {
        assetTypes: ['battlecard'],
        productContext: 'test docs',
        voiceProfileIds: ['voice-1', 'voice-2'],
      };

      await createSession('user-1', input);

      // Check the insert was called with voiceProfileId=null and metadata containing the IDs
      const insertCall = mockInsertValues.mock.calls[0][0];
      expect(insertCall.voiceProfileId).toBeNull();
      const metadata = JSON.parse(insertCall.metadata);
      expect(metadata.voiceProfileIds).toEqual(['voice-1', 'voice-2']);
    });

    it('stores single voiceProfileId in column when one voice selected via legacy field', async () => {
      const input = {
        assetTypes: ['battlecard'],
        productContext: 'test docs',
        voiceProfileId: 'voice-1',
      };

      await createSession('user-1', input);

      const insertCall = mockInsertValues.mock.calls[0][0];
      expect(insertCall.voiceProfileId).toBe('voice-1');
      const metadata = JSON.parse(insertCall.metadata);
      expect(metadata.voiceProfileIds).toBeUndefined();
    });

    it('stores null voiceProfileId when no voices selected (generates for all)', async () => {
      const input = {
        assetTypes: ['battlecard'],
        productContext: 'test docs',
      };

      await createSession('user-1', input);

      const insertCall = mockInsertValues.mock.calls[0][0];
      expect(insertCall.voiceProfileId).toBeNull();
      const metadata = JSON.parse(insertCall.metadata);
      expect(metadata.voiceProfileIds).toBeUndefined();
    });

    it('prefers voiceProfileIds array over single voiceProfileId', async () => {
      const input = {
        assetTypes: ['battlecard'],
        productContext: 'test docs',
        voiceProfileId: 'voice-single',
        voiceProfileIds: ['voice-1', 'voice-2'],
      };

      await createSession('user-1', input);

      const insertCall = mockInsertValues.mock.calls[0][0];
      // When array is provided, column should be null (array takes precedence)
      expect(insertCall.voiceProfileId).toBeNull();
      const metadata = JSON.parse(insertCall.metadata);
      expect(metadata.voiceProfileIds).toEqual(['voice-1', 'voice-2']);
    });

    it('treats empty voiceProfileIds array same as no selection', async () => {
      const input = {
        assetTypes: ['battlecard'],
        productContext: 'test docs',
        voiceProfileIds: [],
      };

      await createSession('user-1', input);

      const insertCall = mockInsertValues.mock.calls[0][0];
      expect(insertCall.voiceProfileId).toBeNull();
      const metadata = JSON.parse(insertCall.metadata);
      expect(metadata.voiceProfileIds).toBeUndefined();
    });
  });
});
