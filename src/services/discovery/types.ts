// Source types for discovery
export type SourceType = 'grounded_search' | 'reddit' | 'stackoverflow' | 'hackernews' | 'github' | 'slack';

export interface DiscoverySource {
  type: SourceType;
  discover: (config: SourceConfig) => Promise<RawDiscoveredPainPoint[]>;
}

export interface SourceConfig {
  keywords: string[];
  subreddits?: string[];
  tags?: string[];
  repositories?: string[];
  searchQueries?: string[];
  slackChannels?: string[];
  maxResults?: number;
}

export interface RawDiscoveredPainPoint {
  sourceType: SourceType;
  sourceUrl: string;
  sourceId: string;
  title: string;
  content: string;
  author: string;
  metadata: Record<string, unknown>;
  discoveredAt: string;
}

export interface ScoredPainPoint extends RawDiscoveredPainPoint {
  painScore: number;
  painAnalysis: PainAnalysis;
  practitionerQuotes: string[];  // NEW: extracted raw quotes from post content
  authorLevel: string;
  contentHash: string;
}

export interface PainAnalysis {
  score: number;
  reasoning: string;
  authorLevel: 'beginner' | 'intermediate' | 'advanced';
  painPoints: string[];
  emotionalIndicators: string[];
  technicalDepth: number;  // 1-10
  urgency: number;  // 1-10
  specificity: number;  // 1-10
  messagingRelevance: number;  // NEW: 1-10, is this pain messageable?
  extractedQuotes: string[];  // NEW: exact quotes expressing pain
}

export interface DiscoveryResult {
  scheduleId: string;
  sourceType: SourceType;
  stats: {
    discovered: number;
    scored: number;
    stored: number;
    duplicates: number;
    belowThreshold: number;
  };
  posts: ScoredPainPoint[];
}
