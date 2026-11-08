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
    xai: env('XAI_API_KEY', ''),
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
    textModel: 'grok-4.7',
    imageModel: 'grok-imagine-image-2.0',
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

} as const;

export function validateConfig(): void {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!config.apiKeys.xai) {
    warnings.push('XAI_API_KEY is not set — model calls will fail');
  }
  if (!config.apiKeys.github) {
    warnings.push('GITHUB_TOKEN is not set — GitHub discovery will fail');
  }

  // Check for insecure defaults
  if (config.admin.password === 'changeme') {
    warnings.push('ADMIN_PASSWORD is set to default "changeme" — change in production');
  }
  if (config.admin.jwtSecret.includes('dev-secret')) {
    if (config.server.nodeEnv !== 'development') {
      throw new Error(
        'FATAL: JWT_SECRET is the default development secret. Refusing to start in ' +
        config.server.nodeEnv + ' mode. Set JWT_SECRET to a secure random string.'
      );
    }
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
    if (!config.apiKeys.xai) {
      errors.push('XAI_API_KEY is required in production');
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
// Model profile names remain so existing sessions still record economy/premium.
// Both profiles use grok-4.7. There is no second provider to switch to.
// ---------------------------------------------------------------------------

export type ModelProfile = 'economy' | 'premium';

export type ModelTask = 'flash' | 'pro' | 'deepResearch' | 'generation' | 'scoring' | 'deslop';

const XAI_TEXT_MODEL = 'grok-4.7';

const MODEL_PROFILES: Record<ModelProfile, Record<ModelTask, string>> = {
  premium: {
    flash: XAI_TEXT_MODEL,
    pro: XAI_TEXT_MODEL,
    deepResearch: XAI_TEXT_MODEL,
    generation: XAI_TEXT_MODEL,
    scoring: XAI_TEXT_MODEL,
    deslop: XAI_TEXT_MODEL,
  },
  economy: {
    flash: XAI_TEXT_MODEL,
    pro: XAI_TEXT_MODEL,
    deepResearch: XAI_TEXT_MODEL,
    generation: XAI_TEXT_MODEL,
    scoring: XAI_TEXT_MODEL,
    deslop: XAI_TEXT_MODEL,
  },
};

export function getActiveModelProfile(): ModelProfile {
  return (process.env.MODEL_PROFILE as ModelProfile) || 'economy';
}

export function getModelForTask(task: ModelTask): string {
  const profile = getActiveModelProfile();
  return MODEL_PROFILES[profile][task];
}

export function isEconomyProfile(): boolean {
  return getActiveModelProfile() === 'economy';
}
