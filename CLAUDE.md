# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

This is the **PMM Messaging Engine**, an automated system that converts practitioner pain points and product documentation into scored, traceable messaging assets. It uses AI-powered generation (Gemini by default) with a voice profile system, community evidence grounding, and a workspace UI for iterative refinement.

**Core value proposition**: Every messaging asset is grounded in real community evidence, enriched with competitive intelligence, generated in a controlled voice, stress-tested for quality, and fully traceable back to its source.

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM)
- **Backend**: Hono (lightweight web framework)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Admin UI**: Vite + React + React Router + Tailwind CSS (in `admin/`)
- **AI Models**: Gemini Flash (scoring, classification), Gemini Pro (generation, deslop), Gemini Deep Research (community/competitive research), Claude (optional override)
- **Auth**: JWT via jose (jsonwebtoken replacement), bcryptjs for passwords
- **IDs**: nanoid (21-character string IDs)
- **Process Manager**: PM2 via `ecosystem.config.cjs`
- **Testing**: Vitest (5min timeout per test)

## Key Architectural Decisions

1. **SQLite over PostgreSQL**: Single-file database for simplicity. This is an internal PMM tool, not a high-concurrency service.

2. **Model Profile System**: `MODEL_PROFILE` env var switches all models between premium (Gemini 3) and economy (all Gemini 2.5 Flash). See `getModelForTask()` in `config.ts`.

3. **JSON in TEXT columns**: Complex nested data stored as JSON-serialized TEXT in SQLite. Always `JSON.parse()` on read, `JSON.stringify()` on write.

4. **Traceability as first-class concern**: Every messaging asset has a complete `asset_traceability` record linking back to pain points, research, product docs, and generation prompts.

5. **Voice profiles drive quality gates**: Scoring thresholds are per-voice-profile, not global. Different audiences have different quality bars.

6. **LLM call logging**: Every AI call is logged to the `llm_calls` table via fire-and-forget `logCall()`. Context is threaded via AsyncLocalStorage (`withLLMContext()`).

7. **Pipeline composability**: All 5 pipelines share core primitives from `orchestrator.ts` (generateAndScore, refinementLoop, storeVariant). Workspace actions also compose from these primitives.

## Database

- **ORM**: Drizzle with better-sqlite3 driver
- **Schema**: `src/db/schema.ts` — **20 tables**
- **Migrations**: Drizzle Kit (`drizzle.config.ts`)
- **Connection**: `src/db/index.ts`

### 20 Tables

1. `messaging_priorities` — Strategic messaging themes
2. `discovery_schedules` — Source polling configuration
3. `discovered_pain_points` — Extracted pain points from community sources
4. `generation_jobs` — Messaging generation job tracking with pipeline steps
5. `settings` — Key-value system configuration
6. `product_documents` — Uploaded product context documents
7. `messaging_assets` — Generated messaging assets (primary output)
8. `persona_critics` — AI critic personas for quality scoring
9. `persona_scores` — Individual scores per (asset, critic)
10. `competitive_research` — Gemini Deep Research results
11. `asset_traceability` — Full evidence chain for each asset
12. `messaging_gaps` — Identified messaging coverage gaps
13. `voice_profiles` — Voice/tone profiles for generation and scoring
14. `asset_variants` — Alternate versions of assets per voice profile
15. `users` — Workspace user accounts (bcrypt passwords, roles)
16. `sessions` — Workspace sessions (pain point, voice, asset types, pipeline config)
17. `session_versions` — Versioned asset content per session with scores and source tracking
18. `session_messages` — Chat refinement message history per session
19. `action_jobs` — Async background workspace actions with progress tracking
20. `llm_calls` — Every LLM call logged (model, purpose, tokens, latency, success)

See `DATABASE.md` for complete schema details.

## Model Profile System

Controlled by `MODEL_PROFILE` env var (`'economy'` | `'premium'`).

| Task | Premium Model | Economy Model |
|------|--------------|---------------|
| flash | gemini-3-flash-preview | gemini-2.5-flash |
| pro | gemini-3-pro-preview | gemini-2.5-flash |
| deepResearch | deep-research-pro-preview | gemini-2.5-flash |
| generation | gemini-3-pro-preview | gemini-2.5-flash |
| scoring | gemini-3-flash-preview | gemini-2.5-flash |
| deslop | gemini-3-pro-preview | gemini-2.5-flash |

Use `getModelForTask(task)` from `config.ts` — never hardcode model names. Claude (`claude-opus-4-6`) is opt-in override only when user explicitly selects it.

## LLM Call Logging

- **`src/services/ai/call-logger.ts`** — `logCall()` persists every LLM call to the `llm_calls` table. Fire-and-forget, never throws.
- **`src/services/ai/call-context.ts`** — `withLLMContext({purpose, jobId, sessionId}, fn)` uses AsyncLocalStorage to thread context through async call chains. All LLM calls within `fn` automatically inherit the context for logging.
- Every call in `src/services/ai/clients.ts` (generateWithClaude, generateWithGemini, generateWithGeminiGroundedSearch) calls `logCall()` on success and failure.

## 5 Generation Pipelines

1. **Standard** — Deep PoV extraction → community + competitive research → PoV-first generation → refinement loop
2. **Outside-In** — Community-first; fails hard if no real evidence (no fallback). Pain-grounded draft → competitive enrichment → refinement
3. **Adversarial** — Generate → 2 rounds of attack/defend → refinement loop
4. **Multi-Perspective** — 3 perspective rewrites (empathy, competitive, thought leadership) → synthesize → refinement loop
5. **Straight-Through** — Score-only, no generation. Evaluates existing messaging content

All pipelines dispatch via `PIPELINE_RUNNERS` map in `orchestrator.ts`.

## 8 Asset Types

| Type | Label | Template |
|------|-------|---------|
| `battlecard` | Battlecard | `templates/battlecard.md` |
| `talk_track` | Talk Track | `templates/talk-track.md` |
| `launch_messaging` | Launch Messaging | `templates/launch-messaging.md` |
| `social_hook` | Social Hook | `templates/social-hook.md` |
| `one_pager` | One-Pager | `templates/one-pager.md` |
| `email_copy` | Email Copy | `templates/email-copy.md` |
| `messaging_template` | Messaging Template | `templates/messaging-template.md` |
| `narrative` | Narrative | `templates/narrative.md` |

Each has a generation temperature defined in `ASSET_TYPE_TEMPERATURE` (range 0.5–0.85).

## Quality Gates

5 scoring dimensions (0–10 scale):
1. **Slop** (inverted — lower is better) — AI cliches, filler language
2. **Vendor-Speak** (inverted — lower is better) — Self-congratulatory vendor language
3. **Authenticity** (higher is better) — Sounds like a real human wrote it
4. **Specificity** (higher is better) — Concrete details, not vague generalities
5. **Persona-Fit** (higher is better) — Resonates with target persona

Scoring is centralized in `src/services/quality/score-content.ts`. All 5 scorers run in parallel with fallback to score 5 on failure. `ScorerHealth` tracks which scorers succeeded/failed.

### Banned Words System
- `DEFAULT_BANNED_WORDS` constant: 13 common vendor-speak phrases
- `generateBannedWords()`: LLM-generated per-voice banned words (retries 3x with backoff)
- Cached per `voiceId:domain` in memory

## Workspace System

The workspace provides a session-based UI for creating, refining, and managing messaging assets.

### Core Components
- **Sessions** (`src/services/workspace/sessions.ts`) — Create sessions with pain point, voice profile(s), asset types, product docs, pipeline selection. Auto-names via Gemini Flash from extracted insights.
- **Versions** (`src/services/workspace/versions.ts`) — Every change creates a new version with scores. `isActive` flag tracks which version is current. Supports activation of any previous version.
- **Chat** (`src/services/workspace/chat-context.ts`) — Conversational refinement with context assembly (system prompt + voice guide + product context + active versions + message history). 150K token budget with oldest-first trimming.
- **Actions** (`src/services/workspace/actions.ts`) — Workspace-specific actions: deslop, regenerate, voice change, adversarial loop, competitive deep dive, community check, multi-perspective rewrite. All compose from pipeline primitives.
- **Action Runner** (`src/services/workspace/action-runner.ts`) — Fire-and-forget background execution with progress tracking via `action_jobs` table.

### Auth
- **`src/services/auth/users.ts`** — User registration/login. First user auto-gets admin role. Passwords hashed with bcryptjs (12 rounds).
- Fallback to env var admin credentials for backwards compatibility.
- JWT tokens via jose with configurable expiration (default 7d).

## API Routes

### Public (rate limited, no auth)
- `POST /api/upload` — File upload
- `POST /api/extract` — Text extraction from uploaded files
- `GET /api/voices` — Active voice profiles
- `GET /api/asset-types` — Available asset types
- `GET /api/history` — Past generations
- `POST /api/auth/login` — Login (users table + env var fallback)
- `POST /api/auth/signup` — User registration

### Admin (JWT auth required)
- `/api/admin/documents` — Product document CRUD
- `/api/admin/voices` — Voice profile CRUD
- `/api/admin/settings` — Settings management
- `GET /api/admin/stats` — Dashboard statistics

### Workspace (JWT auth required)
- `GET /api/workspace/sessions` — List user sessions
- `POST /api/workspace/sessions` — Create + start session
- `GET /api/workspace/sessions/:id` — Get session with results/versions
- `GET /api/workspace/sessions/:id/status` — Poll generation progress
- `PATCH /api/workspace/sessions/:id` — Update session (name, archive)
- `DELETE /api/workspace/sessions/:id` — Delete session
- `GET /api/workspace/sessions/:id/versions/:assetType` — List versions
- `POST /api/workspace/sessions/:id/versions/:assetType/edit` — Create edit version
- `POST /api/workspace/sessions/:id/versions/:versionId/activate` — Activate version
- `POST /api/workspace/sessions/:id/actions/:assetType/:action` — Run workspace action
- `GET /api/workspace/sessions/:id/actions/:jobId` — Poll action progress
- `POST /api/workspace/sessions/:id/chat` — SSE streaming chat refinement
- `GET /api/workspace/sessions/:id/messages` — Chat message history
- `GET /api/workspace/sessions/:id/llm-calls` — LLM call log for session

## Key File Locations

```
src/
  index.ts                              # Server entry — Hono + static files + SPA routing
  config.ts                             # Config + Model Profile System (getModelForTask)
  db/
    schema.ts                           # All 20 table definitions
    index.ts                            # Database connection + initialization
    seed.ts                             # Seed data (voice profiles, priorities)
  services/
    ai/
      clients.ts                        # Gemini + Claude clients, grounded search, deep research, JSON generation
      call-logger.ts                    # Fire-and-forget LLM call logging
      call-context.ts                   # AsyncLocalStorage context threading
      types.ts                          # AI type definitions
    auth/
      users.ts                          # User registration, authentication, lookup
    pipeline/
      orchestrator.ts                   # Shared pipeline primitives + dispatch
      evidence.ts                       # Community/competitive research bundling
      prompts.ts                        # All prompt builders, templates, banned words
      pipelines/
        standard.ts                     # Standard pipeline
        outside-in.ts                   # Outside-in pipeline
        adversarial.ts                  # Adversarial pipeline
        multi-perspective.ts            # Multi-perspective pipeline
        straight-through.ts             # Score-only pipeline
    workspace/
      sessions.ts                       # Session CRUD + generation kickoff
      versions.ts                       # Version management
      actions.ts                        # Workspace actions (deslop, regenerate, etc.)
      action-runner.ts                  # Background action execution
      chat-context.ts                   # Chat context assembly
    quality/
      score-content.ts                  # Centralized scoring (5 parallel scorers)
      slop-detector.ts                  # Pattern detection + AI slop analysis
      vendor-speak.ts                   # Vendor language scoring
      authenticity.ts                   # Human-likeness scoring
      specificity.ts                    # Concrete detail scoring
      persona-critic.ts                 # Persona fit scoring
      grounding-validator.ts            # Fabrication detection + stripping
    product/
      insights.ts                       # Product insight extraction + formatting
    research/
      deep-research.ts                  # Deep Research interaction management
    documents/
      manager.ts                        # Document management
    discovery/
      types.ts                          # Discovery type definitions
    generation/
      types.ts                          # AssetType definition
  api/
    index.ts                            # Route registration + auth endpoints
    generate.ts                         # Public generation routes + re-exports
    validation.ts                       # Zod request schemas
    middleware/
      auth.ts                           # JWT auth (admin + workspace middleware)
      rate-limit.ts                     # Token bucket rate limiter
    admin/
      documents.ts                      # Product document routes
      voices.ts                         # Voice profile routes
      settings.ts                       # Settings routes
    workspace/
      index.ts                          # Workspace route mounting
      sessions.ts                       # Session + version + action routes
      chat.ts                           # SSE chat streaming routes
  types/
    index.ts                            # Centralized type exports
  utils/
    hash.ts                             # generateId() + hashContent()
    logger.ts                           # Structured logging (pino-style)
    retry.ts                            # withRetry, withTimeout, createRateLimiter

templates/                              # Markdown prompt templates (8 asset types)
tests/
  e2e/                                  # End-to-end pipeline tests
    pipeline.test.ts                    # Single pipeline test
    all-pipelines.test.ts               # All 5 pipelines
    community-evidence.test.ts          # Evidence grounding test
    spirit-scoring.ts                   # LLM-based spirit validation
  unit/                                 # Unit tests
    architecture/                       # model-profile-guard, no-cron
    auth/                               # auth tests
    product/                            # insights tests
    quality/                            # gates, score-content, slop-detector, product-filter
    workspace/                          # versions, chat-context, naming, multi-voice, version-activation, adversarial-loop, go-outside-integrity, actions-integrity
  integration/                          # Integration tests
    naming-gemini.test.ts               # Session naming with real Gemini
  debug/                                # Debug utilities

admin/                                  # Vite + React admin/workspace UI
vitest.config.ts                        # 5min timeout, forks pool, single fork (SQLite)
ecosystem.config.cjs                    # PM2 config
deploy.sh                              # Build + commit + PM2 restart
start.sh / stop.sh                      # PM2 start/stop wrappers
```

## Evidence & Research

### Grounded Search
- `generateWithGeminiGroundedSearch()` uses Gemini's `googleSearch` tool
- Retries up to 5x on empty results (flaky API behavior)
- Extracts sources from `groundingMetadata.groundingChunks`

### Community Deep Research
- Uses Gemini Deep Research agent for multi-step web research
- Searches Reddit, HN, Stack Overflow, GitHub Issues, dev blogs
- Returns practitioner quotes, source URLs, evidence level classification
- Evidence levels: `strong` (3+ sources, 2+ types), `partial` (1+ source or grounded search), `product-only`
- Retries 3x full community research if no evidence found

### Competitive Research
- Deep research focused on competitor analysis
- Used by Standard, Outside-In, Adversarial pipelines
- Workspace action "Competitive Deep Dive" runs standalone competitive enrichment

## Common Tasks

### Adding a New Asset Type

1. Create template in `templates/` (e.g., `new-type.md`)
2. Add to `ALL_ASSET_TYPES` array in `src/services/pipeline/prompts.ts`
3. Add entry in `ASSET_TYPE_LABELS` and `ASSET_TYPE_TEMPERATURE`
4. Add type to the `AssetType` union in `src/services/generation/types.ts`

### Adding a New Pipeline

1. Create pipeline file in `src/services/pipeline/pipelines/`
2. Export `runMyPipeline(jobId, inputs)` function
3. Register in `PIPELINE_RUNNERS` map in `orchestrator.ts`
4. Compose from shared primitives: `generateAndScore`, `refinementLoop`, `storeVariant`, `finalizeJob`

### Adding a New Workspace Action

1. Add action function in `src/services/workspace/actions.ts`
2. Use `withLLMContext()` for automatic call logging
3. Use `createVersionAndActivate()` to store results
4. Register in the action dispatch in `src/api/workspace/sessions.ts`

## Environment Setup

```bash
cd /root/messaging-engine
npm install

# Environment variables
cp .env.example .env
# Required: GOOGLE_AI_API_KEY, ANTHROPIC_API_KEY, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD

# Database
npx drizzle-kit push

# Run
pm2 start ecosystem.config.cjs    # or: ./start.sh
pm2 logs messaging-engine

# Build admin UI
cd admin && npm install && npm run build && cd ..

# Deploy (build + commit + restart)
./deploy.sh

# Tests
npm test                           # unit tests (MODEL_PROFILE=economy)
npm run test:e2e                   # e2e tests (5min timeout)
```

### Key Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (3007) | API server port (nginx proxies 91 → 3007) |
| `DATABASE_URL` | No (./data/messaging-engine.db) | SQLite database path |
| `GOOGLE_AI_API_KEY` | Yes | Google AI API key |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `JWT_SECRET` | Yes | JWT signing secret (must change in production) |
| `ADMIN_USERNAME` | Yes | Default admin username |
| `ADMIN_PASSWORD` | Yes | Default admin password |
| `MODEL_PROFILE` | No (economy) | `'economy'` or `'premium'` |
| `NODE_ENV` | No (development) | Environment mode |

## Important Conventions

### IDs
`generateId()` from `src/utils/hash.ts` — 21-character nanoid strings. Never use auto-increment.

### Timestamps
`new Date().toISOString()` — All datetime columns are TEXT with ISO 8601 format.

### Quality Scoring
Scores are on a 0–10 scale. Slop and vendor-speak are inverted (lower is better). Default thresholds: `slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6`.

### Product Name Enforcement
Generation prompts include the product name (extracted from insights) to prevent the LLM from inventing product names.

### No Cron
There is no scheduler/cron in the application. All work is triggered by API requests. There is a unit test (`no-cron.test.ts`) that enforces this.

## Lessons & Hard-Won Rules

These are patterns learned from the project's evolution. Violating them has caused real bugs.

### Never Duplicate scoreContent()
Authenticity scoring was faked as `10 - vendorSpeakScore` in 2 of 3 copy-pasted locations. Always import from `src/services/quality/score-content.ts`. Never copy the scoring logic.

### Never Hardcode maxTokens Low
`maxTokens: 50` on session naming caused 40% empty responses. Newer models have high limits; low hardcoded values cause silent truncation. Only set maxTokens when you need *more* than the 8192 default.

### Outside-In Must Fail Hard
The outside-in pipeline previously fell back silently to standard when no evidence was found. This produced mislabeled output. If no evidence after retries → throw error. Users should pick a different pipeline.

### Product Docs Override Practitioner Voice
Product doc layering in the outside-in pipeline was removed because it overrode the practitioner voice. Be cautious about mixing product positioning into practitioner-first content.

### Grounded Search Is Flaky
Gemini grounded search returns 200 OK with 0 results non-deterministically. Always retry (currently 5x). Same prompt returns rich results on retry.

### Domain-Agnostic Prompts Only
No hardcoded domain language (SRE, observability, etc.) in prompts. All domain context comes from extracted insights. The engine works for any product.

### Process Stability: No File Watchers in Production
PM2 with `tsx watch` caused EADDRINUSE crashes during in-flight Deep Research. Use `node dist/index.js` in production.

### Compose, Don't Duplicate
Workspace actions must compose from pipeline primitives (`generateAndScore`, `refinementLoop`, `storeVariant`). The one exception is `runAdversarialLoopAction` which has unique "elevation mode" logic.

### Evidence Retries Are Layered
Grounded search: 5x retry on empty. Community deep research: 3x full retry if evidence level is `product-only`. These are separate retry loops at different levels.

### Economy Profile Guard
`model-profile-guard.test.ts` fails if tests hit premium models. Always run tests with `MODEL_PROFILE=economy`. Config auto-detects Vitest and defaults to economy.
