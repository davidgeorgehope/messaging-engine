import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { seedVoiceProfiles } from './seed.js';

const logger = createLogger('database');

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;

export async function initializeDatabase() {
  logger.info('Initializing database', { url: config.database.url });

  sqlite = new Database(config.database.url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  renameLegacyResearchColumns(sqlite);

  db = drizzle(sqlite, { schema });

  // Seed OOTB voice profiles if table is empty
  await seedVoiceProfiles();

  logger.info('Database initialized');
  return db;
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

function renameLegacyResearchColumns(database: Database.Database): void {
  const renames: Array<[string, string, string]> = [
    ['generation_jobs', 'gemini_interaction_id', 'research_interaction_id'],
    ['generation_jobs', 'gemini_status', 'research_status'],
    ['competitive_research', 'gemini_interaction_id', 'research_interaction_id'],
  ];
  for (const [table, from, to] of renames) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === from) && !columns.some((column) => column.name === to)) {
      database.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
      logger.info('Renamed legacy research column', { table, from, to });
    }
  }
}

export function closeDatabase() {
  if (sqlite) {
    logger.info('Closing database connection');
    sqlite.close();
  }
}

export { db, schema };
export * from './schema.js';
