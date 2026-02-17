# Messaging Engine — Complete Documentation

## What Is This?

The PMM Messaging Engine converts product documentation and community evidence into scored, traceable marketing messaging assets. It generates battlecards, talk tracks, launch messaging, social hooks, one-pagers, email copy, messaging templates, and narratives — each grounded in real practitioner evidence and stress-tested for quality.

## How It Works

### 1. Users Create Workspace Sessions

A session defines:
- **Product context**: uploaded documents or pasted text
- **Pain point**: discovered from community sources or manually entered
- **Asset types**: which of the 8 messaging formats to generate
- **Voice profile(s)**: tone and audience targeting
- **Pipeline**: which generation strategy to use (5 options)
- **Focus instructions**: optional steering for the generation

### 2. A Generation Pipeline Runs

The selected pipeline (default: Outside-In) executes:
1. **Extract product insights** — domain, category, personas, capabilities via Gemini Flash
2. **Research** — community deep research (practitioner quotes, pain points) + competitive analysis via Gemini Deep Research
3. **Generate** — per asset type × voice, using the pipeline's specific strategy
4. **Score** — 5-dimension quality scoring (slop, vendor-speak, authenticity, specificity, persona fit)
5. **Refine** — iterative improvement until quality gates pass or plateau
6. **Store** — assets, variants, and traceability records

### 3. Users Refine in the Workspace

After generation, users can:
- **Edit** content directly (creates a new scored version)
- **Chat** with the AI to refine specific assets (SSE streaming)
- **Run actions**: deslop, regenerate, voice change, adversarial loop, competitive deep dive, community check, multi-perspective rewrite
- **Compare versions** and activate any previous version
- **Track** all changes with scores and source attribution

## Architecture

```
React UI (Vite + Tailwind) ──→ Hono API Server (port 3007) ──→ SQLite (20 tables)
                                      │
                                      ├── Pipeline Engine (5 pipelines)
                                      ├── Workspace System (sessions, versions, actions, chat)
                                      ├── Quality Scoring (5 parallel scorers)
                                      └── AI Clients (Gemini Flash/Pro/Deep Research + Claude)
```

- **Nginx** proxies port 91 → 3007
- **PM2** manages the Node.js process
- **SQLite** with Drizzle ORM (20 tables, single file)

## 5 Generation Pipelines

| Pipeline | Strategy | When to Use |
|----------|----------|-------------|
| **Standard** | Deep PoV → research → generate → refine | General messaging from product docs |
| **Outside-In** | Community-first, fails without evidence | Maximum practitioner authenticity |
| **Adversarial** | Generate → 2× attack/defend → refine | Battle-tested, objection-proof messaging |
| **Multi-Perspective** | 3 angles → synthesize best → refine | Well-rounded, comprehensive messaging |
| **Straight-Through** | Score only, no generation | Evaluate existing messaging quality |

## 8 Asset Types

| Type | Description |
|------|-------------|
| Battlecard | Competitive comparison and positioning |
| Talk Track | Sales conversation guide |
| Launch Messaging | Product launch announcements |
| Social Hook | Social media engagement hooks |
| One-Pager | Single-page product summary |
| Email Copy | Email campaign content |
| Messaging Template | Comprehensive positioning document (3000–5000 words) |
| Narrative | 3-variant storytelling document |

## Quality System

**5 scoring dimensions** (0–10 scale):
- **Slop** (lower = better): AI cliches, filler, hedging
- **Vendor-Speak** (lower = better): self-congratulatory marketing language
- **Authenticity** (higher = better): sounds like a real human wrote it
- **Specificity** (higher = better): concrete details over vague generalities
- **Persona-Fit** (higher = better): resonates with target audience

**Quality gates** are per-voice-profile. All 5 dimensions must pass their thresholds.

**Banned words**: 13 static defaults + LLM-generated per-voice banned words (cached, 3× retry).

## Model Profile System

`MODEL_PROFILE` env var controls which models are used:

| Task | Production | Test |
|------|-----------|------|
| Flash (scoring, classification) | gemini-3-flash-preview | gemini-2.5-flash |
| Pro (generation, deslop) | gemini-3-pro-preview | gemini-2.5-flash |
| Deep Research | deep-research-pro-preview | gemini-2.5-flash |

Claude (`claude-opus-4-6`) is available as an explicit opt-in override only.

## LLM Call Logging

Every AI call is logged to the `llm_calls` table:
- Model, purpose, prompts, response, token usage, latency, success/failure
- Context (session ID, job ID, purpose) threaded automatically via AsyncLocalStorage
- Fire-and-forget — never blocks or throws

## Database (20 Tables)

**Core**: messaging_priorities, discovery_schedules, discovered_pain_points, generation_jobs, settings, product_documents, messaging_assets, persona_critics, persona_scores, competitive_research, asset_traceability, messaging_gaps, voice_profiles, asset_variants

**Workspace** (new): users, sessions, session_versions, session_messages, action_jobs, llm_calls

See `DATABASE.md` for complete schema reference.

## API Routes

### Public (no auth, rate limited)
- `POST /api/upload` — File upload
- `POST /api/extract` — Text extraction
- `GET /api/voices` — Voice profiles
- `GET /api/asset-types` — Asset types
- `GET /api/history` — Generation history
- `POST /api/auth/login` — Login
- `POST /api/auth/signup` — Register

### Admin (JWT required)
- `/api/admin/documents` — Product documents
- `/api/admin/voices` — Voice profiles
- `/api/admin/settings` — Settings
- `GET /api/admin/stats` — Dashboard stats

### Workspace (JWT required)
- Session CRUD, generation, status polling
- Version management (list, edit, activate)
- Action execution (7 actions) with background progress
- SSE streaming chat refinement
- Message history and LLM call logs

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM)
- **Server**: Hono
- **Database**: SQLite + Drizzle ORM
- **UI**: Vite + React + Tailwind
- **AI**: Google Gemini (primary) + Anthropic Claude (opt-in)
- **Auth**: JWT (jose) + bcryptjs
- **Process**: PM2
- **Testing**: Vitest (5min timeout, forks pool)

## Operations

```bash
# Start/Stop
./start.sh          # PM2 start
./stop.sh           # PM2 stop

# Deploy (build + commit + restart)
./deploy.sh

# Tests
npm test            # Unit tests (MODEL_PROFILE=test)
npm run test:e2e    # E2E tests (5min timeout)

# Logs
pm2 logs messaging-engine
```

## Key Files

| File | Purpose |
|------|---------|
| `src/config.ts` | Config + Model Profile System |
| `src/db/schema.ts` | 20 table definitions |
| `src/services/pipeline/orchestrator.ts` | Pipeline primitives + dispatch |
| `src/services/pipeline/prompts.ts` | All prompt builders |
| `src/services/pipeline/evidence.ts` | Research bundling |
| `src/services/pipeline/pipelines/*.ts` | 5 pipeline implementations |
| `src/services/workspace/*.ts` | Session, version, action, chat |
| `src/services/quality/score-content.ts` | Centralized scoring |
| `src/services/ai/clients.ts` | AI client layer |
| `src/services/ai/call-logger.ts` | LLM call logging |
| `src/services/ai/call-context.ts` | AsyncLocalStorage context |
| `templates/*.md` | 8 asset type templates |

## Design Decisions & Evolution

This section captures the key design decisions and the reasoning behind them, drawn from the project's commit history. Understanding *why* things are the way they are prevents repeating past mistakes.

### The God File Extraction (`a1d9071`, `6e4f7b4`)

`src/api/generate.ts` started as a monolithic "god file" containing all pipeline logic, prompt builders, evidence gathering, and variant storage. It was extracted into `src/services/pipeline/` modules (orchestrator, evidence, prompts, per-pipeline files). Workspace actions were then refactored to compose from these shared primitives rather than duplicating logic. The key insight: **single source of truth for generate+score+refine**, reused by both pipelines and workspace actions.

### Authenticity Scoring Was Faked (`b7aaebd`)

A critical bug: `scoreContent()` was copy-pasted into 3 locations, and 2 of them faked the authenticity score as `Math.max(0, 10 - vendorSpeakScore)` instead of calling the real `analyzeAuthenticity()` scorer. This was caught and fixed by creating a single shared `score-content.ts` module. **Lesson**: never duplicate scoring logic. The shared module now runs all 5 real scorers in parallel with individual fallbacks.

### Outside-In: Fail Hard, No Fallback (`0516c3e`, `9489b8e`)

The outside-in pipeline originally fell back to the standard pipeline when no community evidence was found. This silently produced standard-pipeline output labeled as "outside-in," destroying the pipeline's purpose. The fix: **fail hard with an explicit error** when community evidence retries are exhausted. If the user wants standard pipeline behavior, they should select the standard pipeline. The outside-in pipeline's contract is: real community evidence or nothing.

### Product Doc Layering Removed from Outside-In (`5f0137c`)

Step 6 of the outside-in pipeline ("layer product specifics") was causing the uploaded product doc to override the practitioner voice — the exact thing outside-in is designed to avoid. It was removed entirely. The enriched draft flows directly from competitive enrichment into refinement, keeping practitioner pain front and center.

### Evidence Grounding: Naive Scrapers → AI Discovery → Deep Research (`c19fb5a`, `52a614b`)

The evidence system went through 3 generations:
1. **Direct API scrapers** (Reddit, HN, SO, GitHub, Discourse) — fragile, rate-limited, keyword-dependent
2. **Gemini grounded search** — AI-powered but still keyword-based, returned empty results non-deterministically
3. **Gemini Deep Research** — single call searches all sources natively, eliminates intermediate keyword extraction

The scrapers were deleted (-1,109 lines). Deep Research is now the sole evidence source. Grounded search retries 5x on empty results (the API is flaky — same prompt returns rich results on retry).

### Domain-Agnostic Prompts (`4d976b9`)

All prompts originally had hardcoded observability/SRE language baked in. This was replaced with domain-agnostic language that infers the product domain from extracted insights. The engine now works for any product domain.

### Dynamic Banned Words (`7afe971`, `0eef476`)

The banned words system evolved from a static hardcoded list → dynamic per-voice generation via Gemini Flash. The LLM generates 15-20 voice/domain-specific banned words, cached per `voiceId:domain`. The static list is kept as fallback (3x retry with backoff before falling back).

### maxTokens Truncation Bugs (`ac61fec`, `714c021`)

Hardcoded `maxTokens: 50` on session naming caused Gemini to truncate to 0 tokens 40% of the time. More broadly, low hardcoded `maxTokens` values across 8 call sites caused silent truncation with newer models. Fix: **never hardcode maxTokens unless you need more than the default**. Claude still requires explicit `max_tokens` so it uses 16384.

### Async Background Jobs (`7399146`)

All 7 workspace actions originally ran synchronously, causing Cloudflare 100s timeout for long operations (especially competitive deep dive and community check which involve Deep Research). Solution: `action_jobs` table with fire-and-forget execution. Frontend polls a status endpoint every 3s.

### PM2: tsx watch → node dist (`ac61fec`)

PM2 was originally configured with `tsx watch`, which caused EADDRINUSE crashes when file-watching restarts killed in-flight Deep Research operations. Switched to `node dist/index.js` — more stable for a production process that runs long async operations.

### Chat Switched from Claude to Gemini (`81fd2c9`)

Workspace chat originally used Claude for streaming responses. This was switched to Gemini Pro to keep the entire system on a single AI provider by default. Claude remains available as an opt-in override for generation.

### Model Profile System (`87981d0`, `34aaa9b`)

Created to prevent accidental production model spend during testing. `MODEL_PROFILE=test` swaps all models to Gemini 2.5 Flash. A guard test (`model-profile-guard.test.ts`) fails if tests run against production models. The config auto-detects the Vitest environment and defaults to test profile.

### Split Research Pipeline Removed (`a622121`)

A "split-research" pipeline was removed as redundant with the standard pipeline. This left 4 pipelines (standard, outside-in, adversarial, multi-perspective). The straight-through pipeline was added later as the 5th.

### Sequential DAG Pipelines (`a622121`, `aa698ec`)

Pipelines were refactored from parallel to sequential DAGs — each step feeds the next. Community research findings feed into competitive research prompts. Only multi-perspective retains parallel generation (3 perspectives) by design.

### Tiered Insights Replace Raw Truncation (`c8f4cff`)

Every pipeline was independently truncating raw product docs (often just the executive summary / vendor positioning). Replaced with `extractInsights()` running once per job and 4 tiered formatters providing the right level of context to each stage: discovery (~150 chars), research (~1-2K), generation (~2-3K), scoring (~1-2K). This eliminated vendor framing from community search and competitive research prompts.

### LLM-Based Spirit Validation (`9bd9618`)

E2E tests don't just check that pipelines complete — they use Gemini to score whether the output matches the pipeline's *intent*:
- Outside-in: must be practitioner-driven, low product doc influence
- Standard: must have strong product PoV and thesis
- Adversarial: must feel battle-tested, acknowledge weaknesses
- Multi-perspective: must cover multiple distinct angles

### No Cron (`tests/unit/architecture/no-cron.test.ts`)

There is no scheduler/cron in the application. A unit test enforces this by scanning source files. All work is triggered by API requests. The previous architecture had node-cron for discovery scheduling, but this was removed when the system shifted to an on-demand workspace model.

### Dead Code Sweep (`81fd2c9`)

A major cleanup deleted 25 dead files: 7 frontend pages, 6 admin routes, 11 services, and 18 dead API client methods. The discovery/scheduling/cron pipeline was the primary casualty — replaced by the on-demand workspace model where users create sessions and trigger generation explicitly.
