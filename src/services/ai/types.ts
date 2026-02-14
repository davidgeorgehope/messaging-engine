export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface AIResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  finishReason?: string;
  latencyMs?: number;
}

export interface GenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevanceScore?: number;
}

export interface GroundedSearchResponse {
  text: string;
  sources: SearchResult[];
  usage: TokenUsage;
  model: string;
  searchQueries?: string[];
  latencyMs?: number;
}

export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCachedTokens: number;
  requestCount: number;
  errorCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
    errorCount: number;
    totalLatencyMs: number;
  }>;
}

export interface GenerateJSONOptions extends GenerateOptions {
  schema?: Record<string, unknown>;
  retryOnParseError?: boolean;
  maxParseRetries?: number;
}

export interface DeepResearchInteraction {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  prompt: string;
  result?: {
    text: string;
    sources: SearchResult[];
  };
  createdAt: string;
  completedAt?: string;
}

export interface DeepResearchProgress {
  status: string;
  percentComplete?: number;
  currentStep?: string;
}
