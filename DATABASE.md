# DATABASE.md — Schema Reference

SQLite database via better-sqlite3 + Drizzle ORM.  
Schema defined in `src/db/schema.ts`. 20 tables total.

## Table Overview

| # | Table | Purpose |
|---|-------|---------|
| 1 | `messaging_priorities` | Strategic messaging themes/niches |
| 2 | `discovery_schedules` | Source polling configuration |
| 3 | `discovered_pain_points` | Pain points from community sources |
| 4 | `generation_jobs` | Generation pipeline job tracking |
| 5 | `settings` | Key-value configuration |
| 6 | `product_documents` | Uploaded product context docs |
| 7 | `messaging_assets` | Generated messaging assets (primary output) |
| 8 | `persona_critics` | AI critic personas for scoring |
| 9 | `persona_scores` | Per-asset, per-critic scores |
| 10 | `competitive_research` | Deep Research results |
| 11 | `asset_traceability` | Evidence chain per asset |
| 12 | `messaging_gaps` | Identified coverage gaps |
| 13 | `voice_profiles` | Voice/tone profiles |
| 14 | `asset_variants` | Per-voice asset variants with scores |
| 15 | `users` | Workspace user accounts |
| 16 | `sessions` | Workspace sessions |
| 17 | `session_versions` | Versioned asset content per session |
| 18 | `session_messages` | Chat refinement messages |
| 19 | `action_jobs` | Async workspace action tracking |
| 20 | `llm_calls` | LLM call audit log |

---

## Table 1: `messaging_priorities`

Strategic messaging themes that group pain points and assets.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `name` | TEXT | NOT NULL | Display name |
| `slug` | TEXT | NOT NULL, UNIQUE | URL-safe identifier |
| `description` | TEXT | NOT NULL | Theme description |
| `keywords` | TEXT | NOT NULL | JSON array of keywords |
| `product_context` | TEXT | NOT NULL | Product context for this priority |
| `is_active` | INTEGER | NOT NULL, default true | Active flag |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 2: `discovery_schedules`

Configuration for automated source polling.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `priority_id` | TEXT | NOT NULL, FK → messaging_priorities(id) CASCADE | Parent priority |
| `source_type` | TEXT | NOT NULL | Source type identifier |
| `config` | TEXT | NOT NULL | JSON configuration |
| `is_active` | INTEGER | NOT NULL, default true | Active flag |
| `last_run_at` | TEXT | nullable | Last execution time |
| `next_run_at` | TEXT | nullable | Scheduled next run |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 3: `discovered_pain_points`

Pain points extracted from community sources or manually entered.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `priority_id` | TEXT | NOT NULL, FK → messaging_priorities(id) CASCADE | Parent priority |
| `schedule_id` | TEXT | FK → discovery_schedules(id) SET NULL | Source schedule |
| `source_type` | TEXT | NOT NULL | 'reddit', 'hn', 'manual', etc. |
| `source_url` | TEXT | NOT NULL | Original URL |
| `source_id` | TEXT | NOT NULL | External identifier |
| `title` | TEXT | NOT NULL | Pain point title |
| `content` | TEXT | NOT NULL | Full content |
| `author` | TEXT | NOT NULL | Author name |
| `author_level` | TEXT | NOT NULL | Author expertise level |
| `metadata` | TEXT | NOT NULL | JSON metadata |
| `pain_score` | REAL | NOT NULL | Pain severity (0–1) |
| `pain_analysis` | TEXT | NOT NULL | JSON analysis |
| `practitioner_quotes` | TEXT | NOT NULL | JSON array of raw quotes |
| `status` | TEXT | NOT NULL, default 'pending' | 'pending', 'approved', 'rejected' |
| `rejection_reason` | TEXT | nullable | Why rejected |
| `content_hash` | TEXT | NOT NULL | Dedup hash |
| `discovered_at` | TEXT | NOT NULL | Discovery timestamp |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 4: `generation_jobs`

Tracks generation pipeline execution.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `pain_point_id` | TEXT | FK → discovered_pain_points(id) CASCADE | Source pain point |
| `priority_id` | TEXT | FK → messaging_priorities(id) CASCADE | Priority context |
| `status` | TEXT | NOT NULL, default 'pending' | 'pending', 'running', 'completed', 'failed' |
| `current_step` | TEXT | nullable | Human-readable progress step |
| `progress` | INTEGER | NOT NULL, default 0 | Progress percentage (0–100) |
| `competitive_research` | TEXT | nullable | JSON research results |
| `product_context` | TEXT | nullable | JSON: productDocs, voiceProfileIds, assetTypes, model, pipeline, etc. |
| `error_message` | TEXT | nullable | Error description |
| `error_stack` | TEXT | nullable | Error stack trace |
| `retry_count` | INTEGER | NOT NULL, default 0 | Retry attempts |
| `gemini_interaction_id` | TEXT | nullable | Deep Research interaction ID |
| `gemini_status` | TEXT | nullable | Deep Research status |
| `started_at` | TEXT | nullable | Start timestamp |
| `pipeline_steps` | TEXT | nullable | JSON array of pipeline step events |
| `completed_at` | TEXT | nullable | Completion timestamp |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 5: `settings`

Key-value configuration store.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `priority_id` | TEXT | FK → messaging_priorities(id) CASCADE | Scoped to priority (optional) |
| `key` | TEXT | NOT NULL | Setting key |
| `value` | TEXT | NOT NULL | Setting value |
| `description` | TEXT | NOT NULL | Human description |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 6: `product_documents`

Uploaded product documentation used as generation context.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `name` | TEXT | NOT NULL | Document name |
| `description` | TEXT | NOT NULL | Description |
| `content` | TEXT | NOT NULL | Full text content |
| `document_type` | TEXT | NOT NULL | Type classification |
| `tags` | TEXT | NOT NULL | JSON array of tags |
| `is_active` | INTEGER | NOT NULL, default true | Active flag |
| `uploaded_at` | TEXT | NOT NULL | Upload timestamp |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 7: `messaging_assets`

Generated messaging assets — the primary output of the system.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `priority_id` | TEXT | NOT NULL, FK → messaging_priorities(id) CASCADE | Priority context |
| `job_id` | TEXT | FK → generation_jobs(id) SET NULL | Source generation job |
| `pain_point_id` | TEXT | FK → discovered_pain_points(id) SET NULL | Source pain point |
| `asset_type` | TEXT | NOT NULL | Asset type (8 types) |
| `title` | TEXT | NOT NULL | Asset title |
| `content` | TEXT | NOT NULL | Full generated content |
| `metadata` | TEXT | NOT NULL | JSON: generationId, voiceId, voiceName, voiceSlug, etc. |
| `slop_score` | REAL | nullable | Slop score (0–10, lower is better) |
| `vendor_speak_score` | REAL | nullable | Vendor-speak score (0–10, lower is better) |
| `specificity_score` | REAL | nullable | Specificity score (0–10, higher is better) |
| `persona_avg_score` | REAL | nullable | Persona average (0–10, higher is better) |
| `evidence_level` | TEXT | nullable | 'strong', 'partial', 'product-only' |
| `status` | TEXT | NOT NULL, default 'draft' | 'draft', 'review', 'approved' |
| `review_notes` | TEXT | nullable | Reviewer notes |
| `approved_at` | TEXT | nullable | Approval timestamp |
| `approved_by` | TEXT | nullable | Approver |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 8: `persona_critics`

AI critic personas used for quality scoring.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `name` | TEXT | NOT NULL | Critic name |
| `description` | TEXT | NOT NULL | Role/perspective description |
| `prompt_template` | TEXT | NOT NULL | Scoring prompt template |
| `is_active` | INTEGER | NOT NULL, default true | Active flag |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 9: `persona_scores`

Individual scores from each critic for each asset.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `asset_id` | TEXT | NOT NULL, FK → messaging_assets(id) CASCADE | Scored asset |
| `persona_id` | TEXT | NOT NULL, FK → persona_critics(id) CASCADE | Scoring critic |
| `score` | REAL | NOT NULL | Score value |
| `feedback` | TEXT | NOT NULL | Textual feedback |
| `strengths` | TEXT | NOT NULL | JSON array |
| `weaknesses` | TEXT | NOT NULL | JSON array |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

## Table 10: `competitive_research`

Stored results from Gemini Deep Research competitive analysis.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `job_id` | TEXT | NOT NULL, FK → generation_jobs(id) CASCADE | Parent job |
| `pain_point_id` | TEXT | NOT NULL, FK → discovered_pain_points(id) CASCADE | Related pain point |
| `raw_report` | TEXT | NOT NULL | Full research report |
| `structured_analysis` | TEXT | NOT NULL | JSON structured analysis |
| `grounding_sources` | TEXT | NOT NULL | JSON source URLs |
| `gemini_interaction_id` | TEXT | NOT NULL | Deep Research ID |
| `status` | TEXT | NOT NULL, default 'pending' | Research status |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

## Table 11: `asset_traceability`

Complete evidence chain for each generated asset.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `asset_id` | TEXT | NOT NULL, FK → messaging_assets(id) CASCADE | Traced asset |
| `pain_point_id` | TEXT | FK → discovered_pain_points(id) SET NULL | Source pain point |
| `research_id` | TEXT | FK → competitive_research(id) SET NULL | Source research |
| `product_doc_id` | TEXT | FK → product_documents(id) SET NULL | Source document |
| `practitioner_quotes` | TEXT | NOT NULL | JSON array of quotes |
| `generation_prompt` | TEXT | nullable | JSON: {system, user, timestamp} |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

## Table 12: `messaging_gaps`

Identified gaps in messaging coverage.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `pain_point_id` | TEXT | FK → discovered_pain_points(id) SET NULL | Related pain point |
| `description` | TEXT | NOT NULL | Gap description |
| `suggested_capability` | TEXT | NOT NULL | Suggested capability |
| `frequency` | INTEGER | NOT NULL, default 1 | Occurrence count |
| `status` | TEXT | NOT NULL, default 'open' | 'open', 'addressed' |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 13: `voice_profiles`

Voice and tone profiles for generation and quality scoring.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `name` | TEXT | NOT NULL | Profile name |
| `slug` | TEXT | NOT NULL, UNIQUE | URL-safe slug |
| `description` | TEXT | NOT NULL | Profile description |
| `voice_guide` | TEXT | NOT NULL | Full voice guide text |
| `scoring_thresholds` | TEXT | NOT NULL | JSON: {slopMax, vendorSpeakMax, authenticityMin, specificityMin, personaMin} |
| `example_phrases` | TEXT | NOT NULL | JSON array of example phrases |
| `is_default` | INTEGER | NOT NULL, default false | Default profile flag |
| `is_active` | INTEGER | NOT NULL, default true | Active flag |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 14: `asset_variants`

Per-voice variants of messaging assets with full quality scores.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `asset_id` | TEXT | NOT NULL, FK → messaging_assets(id) CASCADE | Parent asset |
| `voice_profile_id` | TEXT | NOT NULL, FK → voice_profiles(id) CASCADE | Voice used |
| `variant_number` | INTEGER | NOT NULL | Variant sequence number |
| `content` | TEXT | NOT NULL | Variant content |
| `slop_score` | REAL | nullable | Slop score |
| `vendor_speak_score` | REAL | nullable | Vendor-speak score |
| `authenticity_score` | REAL | nullable | Authenticity score |
| `specificity_score` | REAL | nullable | Specificity score |
| `persona_avg_score` | REAL | nullable | Persona average score |
| `passes_gates` | INTEGER | NOT NULL, default false | Quality gate result |
| `is_selected` | INTEGER | NOT NULL, default false | Selected variant flag |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

## Table 15: `users`

Workspace user accounts.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `username` | TEXT | NOT NULL, UNIQUE | Login username |
| `email` | TEXT | NOT NULL, UNIQUE | Email address |
| `password_hash` | TEXT | NOT NULL | bcrypt hash (12 rounds) |
| `display_name` | TEXT | NOT NULL | Display name |
| `role` | TEXT | NOT NULL, default 'user' | 'user' or 'admin' |
| `is_active` | INTEGER | NOT NULL, default true | Active flag |
| `last_login_at` | TEXT | nullable | Last login timestamp |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

**Note**: First registered user automatically gets `admin` role.

## Table 16: `sessions`

Workspace sessions — the primary workspace unit. Contains all configuration for a generation run.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `user_id` | TEXT | NOT NULL, FK → users(id) CASCADE | Owner |
| `name` | TEXT | NOT NULL | Session name (auto-generated from insights) |
| `pain_point_id` | TEXT | FK → discovered_pain_points(id) SET NULL | Linked pain point |
| `job_id` | TEXT | FK → generation_jobs(id) SET NULL | Generation job |
| `voice_profile_id` | TEXT | FK → voice_profiles(id) SET NULL | Primary voice profile |
| `asset_types` | TEXT | NOT NULL | JSON array of AssetType strings |
| `status` | TEXT | NOT NULL, default 'pending' | 'pending', 'generating', 'completed', 'failed' |
| `manual_pain_point` | TEXT | nullable | JSON: {title, description, quotes?} |
| `product_doc_ids` | TEXT | nullable | JSON array of product_documents IDs |
| `product_context` | TEXT | nullable | Pasted/uploaded text context |
| `focus_instructions` | TEXT | nullable | User focus/instructions |
| `pipeline` | TEXT | default 'outside-in' | Pipeline selection |
| `metadata` | TEXT | default '{}' | JSON: voiceProfileIds, existingMessaging, modelProfile, etc. |
| `is_archived` | INTEGER | NOT NULL, default false | Archive flag |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

**Note**: Multi-voice support via `metadata.voiceProfileIds` array. Single voice via `voice_profile_id` column.

## Table 17: `session_versions`

Versioned asset content per session. Every change (generation, edit, deslop, chat, etc.) creates a new version.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) CASCADE | Parent session |
| `asset_type` | TEXT | NOT NULL | Asset type |
| `version_number` | INTEGER | NOT NULL | Sequential version number |
| `content` | TEXT | NOT NULL | Version content |
| `source` | TEXT | NOT NULL | How created: 'generation', 'edit', 'deslop', 'regenerate', 'voice_change', 'adversarial', 'chat', 'competitive_dive', 'community_check', 'multi_perspective' |
| `source_detail` | TEXT | nullable | JSON context about what triggered this version |
| `slop_score` | REAL | nullable | Slop score |
| `vendor_speak_score` | REAL | nullable | Vendor-speak score |
| `authenticity_score` | REAL | nullable | Authenticity score |
| `specificity_score` | REAL | nullable | Specificity score |
| `persona_avg_score` | REAL | nullable | Persona average score |
| `passes_gates` | INTEGER | NOT NULL, default false | Quality gate result |
| `is_active` | INTEGER | NOT NULL, default false | Currently active version |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

## Table 18: `session_messages`

Chat refinement message history per session.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) CASCADE | Parent session |
| `role` | TEXT | NOT NULL | 'user' or 'assistant' |
| `content` | TEXT | NOT NULL | Message text |
| `asset_type` | TEXT | nullable | Which asset tab was focused |
| `version_created` | TEXT | nullable | Version ID if content was accepted |
| `metadata` | TEXT | default '{}' | JSON: token usage, model, latency |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

## Table 19: `action_jobs`

Async background workspace actions with progress tracking.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) CASCADE | Parent session |
| `asset_type` | TEXT | NOT NULL | Target asset type |
| `action_name` | TEXT | NOT NULL | Action identifier |
| `status` | TEXT | NOT NULL, default 'pending' | 'pending', 'running', 'completed', 'failed' |
| `current_step` | TEXT | nullable | Current progress step |
| `progress` | INTEGER | NOT NULL, default 0 | Progress percentage |
| `result` | TEXT | nullable | JSON ActionResult on completion |
| `error_message` | TEXT | nullable | Error message on failure |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |

## Table 20: `llm_calls`

Audit log of every LLM call made by the system.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| `id` | TEXT | PK | nanoid |
| `session_id` | TEXT | FK → sessions(id) CASCADE | Linked workspace session |
| `job_id` | TEXT | FK → generation_jobs(id) SET NULL | Linked generation job |
| `timestamp` | TEXT | NOT NULL | Call timestamp |
| `model` | TEXT | NOT NULL | Model used |
| `purpose` | TEXT | NOT NULL | Call purpose (from AsyncLocalStorage context or explicit) |
| `system_prompt` | TEXT | nullable | System prompt sent |
| `user_prompt` | TEXT | NOT NULL | User prompt sent |
| `response` | TEXT | nullable | Model response |
| `input_tokens` | INTEGER | NOT NULL, default 0 | Input token count |
| `output_tokens` | INTEGER | NOT NULL, default 0 | Output token count |
| `total_tokens` | INTEGER | NOT NULL, default 0 | Total tokens |
| `cached_tokens` | INTEGER | NOT NULL, default 0 | Cached token count |
| `latency_ms` | INTEGER | NOT NULL, default 0 | Response latency |
| `success` | INTEGER | NOT NULL, default true | Success flag |
| `error_message` | TEXT | nullable | Error message on failure |
| `finish_reason` | TEXT | nullable | Model finish reason |
| `created_at` | TEXT | NOT NULL | ISO 8601 |

---

## Relationships

```
messaging_priorities ──< discovery_schedules
messaging_priorities ──< discovered_pain_points
messaging_priorities ──< generation_jobs
messaging_priorities ──< messaging_assets
messaging_priorities ──< settings

discovered_pain_points ──< generation_jobs
discovered_pain_points ──< messaging_assets
discovered_pain_points ──< competitive_research
discovered_pain_points ──< messaging_gaps
discovered_pain_points ──< asset_traceability

generation_jobs ──< competitive_research
generation_jobs ──< sessions (via job_id)
generation_jobs ──< llm_calls (via job_id)

messaging_assets ──< asset_variants
messaging_assets ──< persona_scores
messaging_assets ──< asset_traceability

voice_profiles ──< asset_variants
voice_profiles ──< sessions (via voice_profile_id)

users ──< sessions
sessions ──< session_versions
sessions ──< session_messages
sessions ──< action_jobs
sessions ──< llm_calls (via session_id)

persona_critics ──< persona_scores
product_documents ──< asset_traceability
```

## Conventions

- **IDs**: 21-character nanoid strings via `generateId()`
- **Timestamps**: ISO 8601 TEXT columns, never Unix timestamps
- **JSON columns**: Stored as TEXT, parsed with `JSON.parse()`, serialized with `JSON.stringify()`
- **Boolean columns**: SQLite INTEGER with `{ mode: 'boolean' }` — stores 0/1
- **Cascading deletes**: Most child tables CASCADE on parent delete
- **SET NULL**: Used for optional references that should survive parent deletion
