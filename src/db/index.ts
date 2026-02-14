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

export function closeDatabase() {
  if (sqlite) {
    logger.info('Closing database connection');
    sqlite.close();
  }
}

export { db, schema };
export * from './schema.js';
