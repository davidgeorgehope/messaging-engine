import { eq, and, desc, inArray } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { sessionVersions, sessions, messagingAssets, assetVariants } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { scoreContent, checkQualityGates, DEFAULT_THRESHOLDS } from '../quality/score-content.js';
import type { AssetType } from '../../services/generation/types.js';

const logger = createLogger('workspace:versions');

/**
 * Create initial v1 versions from generation job results.
 * Called after a session's generation job completes.
 */
export async function createInitialVersions(sessionId: string, jobId: string) {
  const db = getDatabase();

  const assets = await db.query.messagingAssets.findMany({
    where: eq(messagingAssets.jobId, jobId),
  });

  const assetIds = assets.map(a => a.id);
  const allVariants = assetIds.length > 0
    ? await db.query.assetVariants.findMany({ where: inArray(assetVariants.assetId, assetIds) })
    : [];

  for (const asset of assets) {
    const variant = allVariants.find(v => v.assetId === asset.id);
    const assetMeta = JSON.parse(asset.metadata || '{}');

    await db.insert(sessionVersions).values({
      id: generateId(),
      sessionId,
      assetType: asset.assetType,
      versionNumber: 1,
      content: asset.content,
      source: 'generation',
      sourceDetail: JSON.stringify({
        assetId: asset.id,
        variantId: variant?.id,
        voiceProfileId: variant?.voiceProfileId,
        ...(assetMeta.images ? { images: assetMeta.images } : {}),
      }),
      slopScore: asset.slopScore,
      vendorSpeakScore: asset.vendorSpeakScore,
      authenticityScore: variant?.authenticityScore ?? null,
      specificityScore: asset.specificityScore,
      personaAvgScore: asset.personaAvgScore,
      narrativeArcScore: (asset as any).narrativeArcScore ?? variant?.narrativeArcScore ?? null,
      passesGates: variant?.passesGates ?? false,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
  }

  logger.info('Created initial versions from job', { sessionId, jobId, count: assets.length });
}

/**
 * Create a new version from an inline edit.
 */
export async function createEditVersion(sessionId: string, assetType: string, content: string) {
  const db = getDatabase();

  // Get the next version number
  const existing = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
    ),
    orderBy: [desc(sessionVersions.versionNumber)],
    limit: 1,
  });

  const nextVersion = (existing[0]?.versionNumber ?? 0) + 1;

  // Deactivate all current active versions for this asset type
  const activeVersions = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
      eq(sessionVersions.isActive, true),
    ),
  });
  for (const v of activeVersions) {
    await db.update(sessionVersions)
      .set({ isActive: false })
      .where(eq(sessionVersions.id, v.id))
      .run();
  }

  // Score the edited content
  const scores = await scoreContent(content);
  const passesGates = checkQualityGates(scores, DEFAULT_THRESHOLDS);

  const versionId = generateId();
  await db.insert(sessionVersions).values({
    id: versionId,
    sessionId,
    assetType,
    versionNumber: nextVersion,
    content,
    source: 'edit',
    sourceDetail: JSON.stringify({ editedAt: new Date().toISOString() }),
    slopScore: scores.slopScore,
    vendorSpeakScore: scores.vendorSpeakScore,
    authenticityScore: scores.authenticityScore,
    specificityScore: scores.specificityScore,
    personaAvgScore: scores.personaAvgScore,
    narrativeArcScore: scores.narrativeArcScore,
    passesGates,
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  const version = await db.query.sessionVersions.findFirst({
    where: eq(sessionVersions.id, versionId),
  });

  logger.info('Created edit version', { sessionId, assetType, versionNumber: nextVersion, passesGates });
  return version!;
}

/**
 * List all versions for a specific asset type in a session.
 */
export async function getVersions(sessionId: string, assetType: string) {
  const db = getDatabase();
  return db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
    ),
    orderBy: [desc(sessionVersions.versionNumber)],
  });
}

/**
 * Activate a specific version (deactivate all others for same asset type).
 */
export async function activateVersion(sessionId: string, versionId: string) {
  const db = getDatabase();

  const version = await db.query.sessionVersions.findFirst({
    where: eq(sessionVersions.id, versionId),
  });
  if (!version || version.sessionId !== sessionId) {
    throw new Error('Version not found');
  }

  // Deactivate all versions for this asset type
  const allVersions = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, version.assetType),
    ),
  });
  for (const v of allVersions) {
    await db.update(sessionVersions)
      .set({ isActive: v.id === versionId })
      .where(eq(sessionVersions.id, v.id))
      .run();
  }

  logger.info('Activated version', { sessionId, versionId, assetType: version.assetType });
  return version;
}
