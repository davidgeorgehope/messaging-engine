type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',  // cyan
  info: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function getMinLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function formatLogEntry(entry: LogEntry): string {
  const color = LOG_COLORS[entry.level];
  const levelStr = entry.level.toUpperCase().padEnd(5);
  const time = entry.timestamp.split('T')[1]?.replace('Z', '') ?? entry.timestamp;

  let line = `${DIM}${time}${RESET} ${color}${levelStr}${RESET} ${BOLD}[${entry.module}]${RESET} ${entry.message}`;

  if (entry.data && Object.keys(entry.data).length > 0) {
    const dataStr = Object.entries(entry.data)
      .map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${DIM}${k}=${RESET}${val}`;
      })
      .join(' ');
    line += ` ${dataStr}`;
  }

  return line;
}

export class Logger {
  private module: string;
  private parentData: Record<string, unknown>;

  constructor(module: string, parentData: Record<string, unknown> = {}) {
    this.module = module;
    this.parentData = parentData;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const minLevel = getMinLevel();
    if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) {
      return;
    }

    const entry: LogEntry = {
      level,
      module: this.module,
      message,
      data: { ...this.parentData, ...data },
      timestamp: new Date().toISOString(),
    };

    const formatted = formatLogEntry(entry);

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'debug':
        console.debug(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  child(childModule: string, childData?: Record<string, unknown>): Logger {
    return new Logger(
      `${this.module}:${childModule}`,
      { ...this.parentData, ...childData }
    );
  }

  withData(data: Record<string, unknown>): Logger {
    return new Logger(this.module, { ...this.parentData, ...data });
  }

  time(label: string): () => void {
    const start = performance.now();
    this.debug(`${label} started`);
    return () => {
      const duration = Math.round(performance.now() - start);
      this.debug(`${label} completed`, { durationMs: duration });
    };
  }
}

export function createLogger(module: string, data?: Record<string, unknown>): Logger {
  return new Logger(module, data);
}
