import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ============================================================================
// Table 1: messaging_priorities (replaces niches)
// ============================================================================
export const messagingPriorities = sqliteTable('messaging_priorities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull(),
  keywords: text('keywords').notNull(), // JSON array
  productContext: text('product_context').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 2: discovery_schedules
// ============================================================================
export const discoverySchedules = sqliteTable('discovery_schedules', {
  id: text('id').primaryKey(),
  priorityId: text('priority_id').notNull().references(() => messagingPriorities.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  config: text('config').notNull(), // JSON
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 3: discovered_pain_points (replaces discoveredPosts)
// ============================================================================
export const discoveredPainPoints = sqliteTable('discovered_pain_points', {
  id: text('id').primaryKey(),
  priorityId: text('priority_id').notNull().references(() => messagingPriorities.id, { onDelete: 'cascade' }),
  scheduleId: text('schedule_id').references(() => discoverySchedules.id, { onDelete: 'set null' }),
  sourceType: text('source_type').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceId: text('source_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  author: text('author').notNull(),
  authorLevel: text('author_level').notNull(),
  metadata: text('metadata').notNull(), // JSON
  painScore: real('pain_score').notNull(),
  painAnalysis: text('pain_analysis').notNull(), // JSON
  practitionerQuotes: text('practitioner_quotes').notNull(), // JSON — extracted raw quotes
  status: text('status').notNull().default('pending'),
  rejectionReason: text('rejection_reason'),
  contentHash: text('content_hash').notNull(),
  discoveredAt: text('discovered_at').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 4: generation_jobs (forked + extended)
// ============================================================================
export const generationJobs = sqliteTable('generation_jobs', {
  id: text('id').primaryKey(),
  painPointId: text('pain_point_id').references(() => discoveredPainPoints.id, { onDelete: 'cascade' }),
  priorityId: text('priority_id').references(() => messagingPriorities.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  currentStep: text('current_step'),
  progress: integer('progress').notNull().default(0),
  competitiveResearch: text('competitive_research'), // JSON
  productContext: text('product_context'), // JSON
  errorMessage: text('error_message'),
  errorStack: text('error_stack'),
  retryCount: integer('retry_count').notNull().default(0),
  geminiInteractionId: text('gemini_interaction_id'),
  geminiStatus: text('gemini_status'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 5: settings
// ============================================================================
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  priorityId: text('priority_id').references(() => messagingPriorities.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 6: product_documents (new)
// ============================================================================
export const productDocuments = sqliteTable('product_documents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  content: text('content').notNull(),
  documentType: text('document_type').notNull(),
  tags: text('tags').notNull(), // JSON
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  uploadedAt: text('uploaded_at').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 7: messaging_assets (new)
// ============================================================================
export const messagingAssets = sqliteTable('messaging_assets', {
  id: text('id').primaryKey(),
  priorityId: text('priority_id').notNull().references(() => messagingPriorities.id, { onDelete: 'cascade' }),
  jobId: text('job_id').references(() => generationJobs.id, { onDelete: 'set null' }),
  painPointId: text('pain_point_id').references(() => discoveredPainPoints.id, { onDelete: 'set null' }),
  assetType: text('asset_type').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata').notNull(), // JSON
  slopScore: real('slop_score'),
  vendorSpeakScore: real('vendor_speak_score'),
  specificityScore: real('specificity_score'),
  personaAvgScore: real('persona_avg_score'),
  status: text('status').notNull().default('draft'),
  reviewNotes: text('review_notes'),
  approvedAt: text('approved_at'),
  approvedBy: text('approved_by'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 8: persona_critics (new)
// ============================================================================
export const personaCritics = sqliteTable('persona_critics', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  promptTemplate: text('prompt_template').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 9: persona_scores (new)
// ============================================================================
export const personaScores = sqliteTable('persona_scores', {
  id: text('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => messagingAssets.id, { onDelete: 'cascade' }),
  personaId: text('persona_id').notNull().references(() => personaCritics.id, { onDelete: 'cascade' }),
  score: real('score').notNull(),
  feedback: text('feedback').notNull(),
  strengths: text('strengths').notNull(), // JSON
  weaknesses: text('weaknesses').notNull(), // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 10: competitive_research (new)
// ============================================================================
export const competitiveResearch = sqliteTable('competitive_research', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => generationJobs.id, { onDelete: 'cascade' }),
  painPointId: text('pain_point_id').notNull().references(() => discoveredPainPoints.id, { onDelete: 'cascade' }),
  rawReport: text('raw_report').notNull(),
  structuredAnalysis: text('structured_analysis').notNull(), // JSON
  groundingSources: text('grounding_sources').notNull(), // JSON
  geminiInteractionId: text('gemini_interaction_id').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 11: asset_traceability (new)
// ============================================================================
export const assetTraceability = sqliteTable('asset_traceability', {
  id: text('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => messagingAssets.id, { onDelete: 'cascade' }),
  painPointId: text('pain_point_id').references(() => discoveredPainPoints.id, { onDelete: 'set null' }),
  researchId: text('research_id').references(() => competitiveResearch.id, { onDelete: 'set null' }),
  productDocId: text('product_doc_id').references(() => productDocuments.id, { onDelete: 'set null' }),
  practitionerQuotes: text('practitioner_quotes').notNull(), // JSON
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 12: messaging_gaps (new)
// ============================================================================
export const messagingGaps = sqliteTable('messaging_gaps', {
  id: text('id').primaryKey(),
  painPointId: text('pain_point_id').references(() => discoveredPainPoints.id, { onDelete: 'set null' }),
  description: text('description').notNull(),
  suggestedCapability: text('suggested_capability').notNull(),
  frequency: integer('frequency').notNull().default(1),
  status: text('status').notNull().default('open'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 13: voice_profiles (new)
// ============================================================================
export const voiceProfiles = sqliteTable('voice_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull(),
  voiceGuide: text('voice_guide').notNull(),
  scoringThresholds: text('scoring_thresholds').notNull(), // JSON
  examplePhrases: text('example_phrases').notNull(), // JSON
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Table 14: asset_variants (new)
// ============================================================================
export const assetVariants = sqliteTable('asset_variants', {
  id: text('id').primaryKey(),
  assetId: text('asset_id').notNull().references(() => messagingAssets.id, { onDelete: 'cascade' }),
  voiceProfileId: text('voice_profile_id').notNull().references(() => voiceProfiles.id, { onDelete: 'cascade' }),
  variantNumber: integer('variant_number').notNull(),
  content: text('content').notNull(),
  slopScore: real('slop_score'),
  vendorSpeakScore: real('vendor_speak_score'),
  authenticityScore: real('authenticity_score'),
  specificityScore: real('specificity_score'),
  personaAvgScore: real('persona_avg_score'),
  passesGates: integer('passes_gates', { mode: 'boolean' }).notNull().default(false),
  isSelected: integer('is_selected', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ============================================================================
// Type exports
// ============================================================================
export type MessagingPriority = typeof messagingPriorities.$inferSelect;
export type InsertMessagingPriority = typeof messagingPriorities.$inferInsert;

export type DiscoverySchedule = typeof discoverySchedules.$inferSelect;
export type InsertDiscoverySchedule = typeof discoverySchedules.$inferInsert;

export type DiscoveredPainPoint = typeof discoveredPainPoints.$inferSelect;
export type InsertDiscoveredPainPoint = typeof discoveredPainPoints.$inferInsert;

export type GenerationJob = typeof generationJobs.$inferSelect;
export type InsertGenerationJob = typeof generationJobs.$inferInsert;

export type Setting = typeof settings.$inferSelect;
export type InsertSetting = typeof settings.$inferInsert;

export type ProductDocument = typeof productDocuments.$inferSelect;
export type InsertProductDocument = typeof productDocuments.$inferInsert;

export type MessagingAsset = typeof messagingAssets.$inferSelect;
export type InsertMessagingAsset = typeof messagingAssets.$inferInsert;

export type PersonaCritic = typeof personaCritics.$inferSelect;
export type InsertPersonaCritic = typeof personaCritics.$inferInsert;

export type PersonaScore = typeof personaScores.$inferSelect;
export type InsertPersonaScore = typeof personaScores.$inferInsert;

export type CompetitiveResearch = typeof competitiveResearch.$inferSelect;
export type InsertCompetitiveResearch = typeof competitiveResearch.$inferInsert;

export type AssetTraceability = typeof assetTraceability.$inferSelect;
export type InsertAssetTraceability = typeof assetTraceability.$inferInsert;

export type MessagingGap = typeof messagingGaps.$inferSelect;
export type InsertMessagingGap = typeof messagingGaps.$inferInsert;

export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type InsertVoiceProfile = typeof voiceProfiles.$inferInsert;

export type AssetVariant = typeof assetVariants.$inferSelect;
export type InsertAssetVariant = typeof assetVariants.$inferInsert;
