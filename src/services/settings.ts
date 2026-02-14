import { eq, and, isNull } from 'drizzle-orm';
import { getDatabase } from '../db/index.js';
import { settings } from '../db/schema.js';
import { config } from '../config.js';
import { generateId } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('settings');

/**
 * Get a global setting value by key. Returns defaultValue if not found.
 */
export async function getSetting(key: string, defaultValue: string): Promise<string> {
  const db = getDatabase();
  const setting = await db.query.settings.findFirst({
    where: and(eq(settings.key, key), isNull(settings.priorityId)),
  });
  return setting?.value ?? defaultValue;
}

/**
 * Get a priority-specific setting value. Falls back to global, then defaultValue.
 */
export async function getPrioritySetting(
  priorityId: string,
  key: string,
  defaultValue: string
): Promise<string> {
  const db = getDatabase();

  // First try priority-specific setting
  const prioritySetting = await db.query.settings.findFirst({
    where: and(eq(settings.key, key), eq(settings.priorityId, priorityId)),
  });

  if (prioritySetting) {
    return prioritySetting.value;
  }

  // Fall back to global setting
  return getSetting(key, defaultValue);
}

/**
 * Set a global setting value. Creates or updates.
 */
export async function setSetting(
  key: string,
  value: string,
  description?: string
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = await db.query.settings.findFirst({
    where: and(eq(settings.key, key), isNull(settings.priorityId)),
  });

  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.id, existing.id));
    logger.debug('Setting updated', { key, value });
  } else {
    await db.insert(settings).values({
      id: generateId(),
      key,
      value,
      description: description ?? '',
      createdAt: now,
      updatedAt: now,
    });
    logger.debug('Setting created', { key, value });
  }
}

/**
 * Set a priority-specific setting value. Creates or updates.
 */
export async function setPrioritySetting(
  priorityId: string,
  key: string,
  value: string,
  description?: string
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = await db.query.settings.findFirst({
    where: and(eq(settings.key, key), eq(settings.priorityId, priorityId)),
  });

  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.id, existing.id));
    logger.debug('Priority setting updated', { priorityId, key, value });
  } else {
    await db.insert(settings).values({
      id: generateId(),
      priorityId,
      key,
      value,
      description: description ?? '',
      createdAt: now,
      updatedAt: now,
    });
    logger.debug('Priority setting created', { priorityId, key, value });
  }
}

/**
 * Get cron schedule settings, with fallback to config defaults.
 */
export async function getCronSettings() {
  const [discoveryCron, generationCron] = await Promise.all([
    getSetting('discovery_cron', config.jobs.discoveryCron),
    getSetting('generation_cron', config.jobs.generationCron),
  ]);
  return { discoveryCron, generationCron };
}

/**
 * Get all settings, optionally filtered by priority.
 */
export async function getAllSettings(priorityId?: string) {
  const db = getDatabase();

  if (priorityId) {
    return db.query.settings.findMany({
      where: eq(settings.priorityId, priorityId),
    });
  }

  return db.query.settings.findMany();
}

/**
 * Delete a setting by key (global only).
 */
export async function deleteSetting(key: string): Promise<boolean> {
  const db = getDatabase();

  const existing = await db.query.settings.findFirst({
    where: and(eq(settings.key, key), isNull(settings.priorityId)),
  });

  if (!existing) {
    return false;
  }

  await db.delete(settings).where(eq(settings.id, existing.id));
  logger.debug('Setting deleted', { key });
  return true;
}
