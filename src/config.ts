import 'dotenv/config';

function env(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${value}`);
  }
  return parsed;
}

function envFloat(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${value}`);
  }
  return parsed;
}

export const config = {
  database: {
    url: env('DATABASE_URL', './data/messaging-engine.db'),
  },

  apiKeys: {
    anthropic: env('ANTHROPIC_API_KEY', ''),
    googleAi: env('GOOGLE_AI_API_KEY', ''),
    github: env('GITHUB_TOKEN', ''),
  },

  server: {
    port: envInt('PORT', 3007),
    host: env('HOST', '0.0.0.0'),
    nodeEnv: env('NODE_ENV', 'development'),
  },

  admin: {
    username: env('ADMIN_USERNAME', 'admin'),
    password: env('ADMIN_PASSWORD', 'changeme'),
    jwtSecret: env('JWT_SECRET', 'messaging-engine-dev-secret-change-in-production'),
    jwtExpiresIn: '7d',
  },

  quality: {
    maxSlopScore: envFloat('MAX_SLOP_SCORE', 0.3),
    maxVendorSpeakScore: envFloat('MAX_VENDOR_SPEAK_SCORE', 0.2),
    minAuthenticityScore: envFloat('MIN_AUTHENTICITY_SCORE', 0.7),
    minSpecificityScore: envFloat('MIN_SPECIFICITY_SCORE', 0.6),
    minPersonaScore: envFloat('MIN_PERSONA_SCORE', 0.7),
  },

  ai: {
    claude: {
      model: 'claude-opus-4-6',
      maxTokens: 16000,
    },
    gemini: {
      flashModel: 'gemini-3-flash-preview',
      proModel: 'gemini-3-pro-preview',
      deepResearchAgent: 'deep-research-pro-preview-12-2025',
    },
  },

  discovery: {
    maxPostsPerRun: envInt('MAX_POSTS_PER_RUN', 50),
    minPainScore: envFloat('MIN_PAIN_SCORE', 0.6),
    deduplicationWindowDays: envInt('DEDUPLICATION_WINDOW_DAYS', 30),
  },

  generation: {
    maxConcurrentJobs: envInt('MAX_CONCURRENT_JOBS', 3),
    maxRetries: envInt('MAX_RETRIES', 3),
    maxDeslopAttempts: envInt('MAX_DESLOP_ATTEMPTS', 1),
  },

  deepResearch: {
    pollIntervalMs: envInt('DEEP_RESEARCH_POLL_INTERVAL_MS', 30000),
    timeoutMs: envInt('DEEP_RESEARCH_TIMEOUT_MS', 3600000),
  },
} as const;

export function validateConfig(): void {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check for default/missing API keys
  if (!config.apiKeys.anthropic) {
    warnings.push('ANTHROPIC_API_KEY is not set — Claude AI calls will fail');
  }
  if (!config.apiKeys.googleAi) {
    warnings.push('GOOGLE_AI_API_KEY is not set — Gemini AI calls will fail');
  }
  if (!config.apiKeys.github) {
    warnings.push('GITHUB_TOKEN is not set — GitHub discovery will fail');
  }

  // Check for insecure defaults
  if (config.admin.password === 'changeme') {
    warnings.push('ADMIN_PASSWORD is set to default "changeme" — change in production');
  }
  if (config.admin.jwtSecret.includes('dev-secret')) {
    warnings.push('JWT_SECRET is using development default — change in production');
  }

  // Production checks
  if (config.server.nodeEnv === 'production') {
    if (config.admin.password === 'changeme') {
      errors.push('ADMIN_PASSWORD must be changed in production');
    }
    if (config.admin.jwtSecret.includes('dev-secret')) {
      errors.push('JWT_SECRET must be changed in production');
    }
    if (!config.apiKeys.anthropic) {
      errors.push('ANTHROPIC_API_KEY is required in production');
    }
    if (!config.apiKeys.googleAi) {
      errors.push('GOOGLE_AI_API_KEY is required in production');
    }
  }

  // Log warnings
  for (const warning of warnings) {
    console.warn(`[config] WARNING: ${warning}`);
  }

  // Throw on errors
  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// Model Profile System — swap all models to Flash for cheap testing
// ---------------------------------------------------------------------------

export type ModelProfile = 'production' | 'test';

export type ModelTask = 'flash' | 'pro' | 'deepResearch' | 'generation' | 'scoring' | 'deslop';

const MODEL_PROFILES: Record<ModelProfile, Record<ModelTask, string>> = {
  production: {
    flash: 'gemini-3-flash-preview',
    pro: 'gemini-3-pro-preview',
    deepResearch: 'deep-research-pro-preview-12-2025',
    generation: 'gemini-3-pro-preview',
    scoring: 'gemini-3-flash-preview',
    deslop: 'gemini-3-pro-preview',
  },
  test: {
    flash: 'gemini-2.5-flash',
    pro: 'gemini-2.5-flash',
    deepResearch: 'gemini-2.5-flash',
    generation: 'gemini-2.5-flash',
    scoring: 'gemini-2.5-flash',
    deslop: 'gemini-2.5-flash',
  },
};

export function getActiveModelProfile(): ModelProfile {
  return (process.env.MODEL_PROFILE as ModelProfile) || 'production';
}

export function getModelForTask(task: ModelTask): string {
  const profile = getActiveModelProfile();
  return MODEL_PROFILES[profile][task];
}

export function isTestProfile(): boolean {
  return getActiveModelProfile() === 'test';
}
