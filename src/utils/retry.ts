import { createLogger } from './logger.js';

const logger = createLogger('retry');

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryOn?: (error: Error) => boolean;
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxRetries) {
        break;
      }

      // Check if we should retry this error
      if (opts.retryOn && !opts.retryOn(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const baseDelay = opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt);
      const jitter = Math.random() * baseDelay * 0.1;
      const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`, {
        error: lastError.message,
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
      });

      if (opts.onRetry) {
        opts.onRetry(lastError, attempt + 1);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

export interface TimeoutOptions {
  timeoutMs: number;
  message?: string;
}

export async function withTimeout<T>(
  fn: () => Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  const { timeoutMs, message } = options;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message ?? `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimiter {
  acquire(): Promise<void>;
  reset(): void;
  readonly pending: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { maxRequests, windowMs } = options;
  const timestamps: number[] = [];
  let pendingCount = 0;

  function cleanup(): void {
    const cutoff = Date.now() - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }

  async function acquire(): Promise<void> {
    pendingCount++;
    try {
      while (true) {
        cleanup();

        if (timestamps.length < maxRequests) {
          timestamps.push(Date.now());
          return;
        }

        // Calculate wait time until the oldest request expires
        const oldestTimestamp = timestamps[0];
        const waitTime = oldestTimestamp + windowMs - Date.now() + 1;

        if (waitTime > 0) {
          logger.debug(`Rate limiter: waiting ${waitTime}ms`, {
            currentRequests: timestamps.length,
            maxRequests,
          });
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    } finally {
      pendingCount--;
    }
  }

  function reset(): void {
    timestamps.length = 0;
  }

  return {
    acquire,
    reset,
    get pending() {
      return pendingCount;
    },
  };
}
