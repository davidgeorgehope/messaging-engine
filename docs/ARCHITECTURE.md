# ARCHITECTURE.md — System Architecture

## Overview

The PMM Messaging Engine is a full-stack application that generates, scores, and refines marketing messaging assets from product documentation and community evidence. Users create workspace sessions, select asset types and voice profiles, choose a generation pipeline, and iteratively refine the output through actions and chat.

```
┌─────────────────────────────────────────────────────────────┐
│                     React Admin/Workspace UI                │
│        (Vite + React Router + Tailwind CSS)                 │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/SSE (port 91 → nginx → 3007)
┌──────────────────────────▼──────────────────────────────────┐
│                      Hono API Server                         │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐             │
│  │  Public   │  │   Admin   │  │  Workspace   │             │
│  │  Routes   │  │  Routes   │  │   Routes     │             │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────┘             │
│       │               │               │                      │
│  ┌────▼───────────────▼───────────────▼───────────────────┐ │
│  │                  Service Layer                          │ │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────┐            │ │
│  │  │ Pipeline │  │Workspace │  │  Quality   │            │ │
│  │  │ Engine   │  │  System  │  │  Scoring   │            │ │
│  │  └────┬─────┘  └────┬─────┘  └─────┬─────┘            │ │
│  │       │              │              │                   │ │
│  │  ┌────▼──────────────▼──────────────▼────────────────┐ │ │
│  │  │                AI Client Layer                     │ │ │
│  │  │  Gemini Flash │ Gemini Pro │ Deep Research │ Claude│ │ │
│  │  │  Call Logger │ Call Context (AsyncLocalStorage)    │ │ │
│  │  └──────────────────────┬────────────────────────────┘ │ │
│  └─────────────────────────┼──────────────────────────────┘ │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│           SQLite (better-sqlite3 + Drizzle ORM)             │
│                    20 tables, single file                    │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. API Layer (`src/api/`)

**Framework**: Hono with CORS, body-limit (50MB for PDFs), and request logging.

**Route groups**:
- **Public** (`/api/`) — Upload, extract, voices, asset-types, history, auth. Rate-limited per endpoint.
- **Admin** (`/api/admin/`) — Documents, voices, settings, stats. JWT auth required.
- **Workspace** (`/api/workspace/`) — Sessions, versions, actions, chat. JWT auth required (user-scoped).

**Auth**: JWT via jose library. Two auth middlewares:
- `adminAuth` — for admin routes (accepts env var credentials or DB users with admin role)
- `workspaceAuth` — for workspace routes (accepts any authenticated user)

Login falls through: DB users table first, then env var admin credentials as fallback.

### 2. Pipeline Engine (`src/services/pipeline/`)

The pipeline engine is the core generation system. All 5 pipelines share common primitives from the orchestrator.

#### Shared Primitives (`orchestrator.ts`)

| Function | Purpose |
|----------|---------|
| `loadJobInputs(jobId)` | Load job configuration (product docs, voices, asset types, pipeline) |
| `generateContent(prompt, options, model?)` | AI dispatch — routes to Gemini or Claude |
| `generateAndScore(prompt, system, model, context, thresholds, assetType)` | Generate + score in one call |
| `refinementLoop(content, context, thresholds, voice, assetType, system, model, maxIter, productName)` | Iterative: deslop → refine → score until gates pass or plateau |
| `storeVariant(jobId, assetType, voice, content, scores, passesGates, ...)` | Store asset + variant + traceability records |
| `emitPipelineStep(jobId, step, status, data?)` | Record pipeline step events to job |
| `updateJobProgress(jobId, fields)` | Update job progress/status |
| `finalizeJob(jobId, researchAvailable, researchLength)` | Mark job complete |

#### Pipeline Dispatch

```typescript
PIPELINE_RUNNERS = {
  'straight-through': runStraightThroughPipeline,
  'standard':         runStandardPipeline,
  'outside-in':       runOutsideInPipeline,
  'adversarial':      runAdversarialPipeline,
  'multi-perspective': runMultiPerspectivePipeline,
};
```

`runPublicGenerationJob(jobId)` loads inputs, resolves session for LLM context, wraps execution in `withLLMContext()`, and dispatches to the appropriate runner.

#### Pipeline Details

**Standard Pipeline**:
1. Deep PoV extraction (Gemini Pro)
2. Community deep research (Deep Research agent) + competitive research
3. PoV-first prompt generation per asset type × voice
4. Refinement loop (up to 3 iterations)
5. Store variants with traceability

**Outside-In Pipeline**:
1. Extract insights (Gemini Flash)
2. Community deep research with **3 full retries** if no evidence
3. **Fails hard** if no community evidence after retries (no fallback)
4. Pain-grounded first draft per asset type × voice
5. Competitive research + enrichment
6. Refinement loop (product doc layering **removed** — keeps practitioner voice pure)
7. Store variants

**Adversarial Pipeline**:
1. Extract insights + community/competitive research
2. Generate initial draft per asset type × voice
3. **2 rounds of attack/defend**: hostile practitioner critique → rewrite to survive objections
4. Refinement loop
5. Store variants

**Multi-Perspective Pipeline**:
1. Extract insights + community/competitive research
2. Generate initial draft per asset type × voice
3. 3 parallel perspective rewrites: empathy, competitive, thought leadership
4. Synthesize best elements from all 3
5. Score all 4 candidates, keep the highest
6. Refinement loop
7. Store variants

**Straight-Through Pipeline**:
1. Extract insights
2. Score existing messaging content (no generation)
3. Store scored results

#### Evidence & Research (`evidence.ts`)

- `runCommunityDeepResearch(insights, prompt)` — Deep Research for practitioner quotes, community pain points
- `runCompetitiveResearch(insights, prompt)` — Deep Research for competitive analysis
- Evidence levels: `strong` (≥3 sources from ≥2 types), `partial` (≥1 source or grounded search), `product-only`
- Grounded search retries 5x on empty results; community research retries 3x

#### Prompts (`prompts.ts`)

- 8 asset types with templates, temperatures, and labels
- `buildSystemPrompt()` — voice guide + asset type instructions + evidence level + banned words + product name
- `buildUserPrompt()` — existing messaging + focus + research + template + insights
- `buildPainFirstPrompt()` — practitioner context first (outside-in)
- `buildPoVFirstPrompt()` — PoV context first (standard)
- `buildRefinementPrompt()` — score-driven improvement instructions
- `generateBannedWords()` — LLM-generated per-voice banned words (3x retry with backoff)

### 3. Workspace System (`src/services/workspace/`)

The workspace provides session-based asset management with versioning, chat, and background actions.

#### Sessions (`sessions.ts`)

- `createSession(userId, data)` — Create with pain point, voice(s), asset types, pipeline, product context
- `startSessionGeneration(sessionId)` — Build generation job, fire pipeline in background
- Auto-naming: placeholder from input → refined by `nameSessionFromInsights()` via Gemini Flash
- Multi-voice: `voiceProfileIds` array in session metadata

#### Versions (`versions.ts`)

- `createInitialVersions(sessionId, jobId)` — Copy generation results as v1
- `createEditVersion(sessionId, assetType, content)` — User inline edit → score → new version
- `activateVersion(sessionId, versionId)` — Switch active version (deactivates others)
- Every version is scored and stores `isActive` flag

#### Actions (`actions.ts`)

7 workspace actions, all wrapped in `withLLMContext()`:

| Action | Description |
|--------|-------------|
| `runDeslopAction` | Analyze slop patterns → deslop → score |
| `runRegenerateAction` | Full regeneration with voice, template, research, refinement loop |
| `runVoiceChangeAction` | Rewrite in a different voice profile |
| `runAdversarialLoopAction` | 1–3 iterations of fix/elevate mode (custom logic, not pipeline refinementLoop) |
| `runCompetitiveDeepDiveAction` | Deep Research competitive analysis → enrichment |
| `runCommunityCheckAction` | Deep Research community evidence → rewrite with practitioner language |
| `runMultiPerspectiveAction` | 3 perspective rewrites → synthesize → score all 4, keep best |

#### Action Runner (`action-runner.ts`)

- `runActionInBackground(sessionId, assetType, actionName, actionFn)` — Fire-and-forget with `action_jobs` tracking
- `getActionJobStatus(jobId)` — Poll progress

#### Chat (`chat-context.ts`)

- `assembleChatContext(sessionId, assetType?)` — Builds system prompt + message history
- System prompt includes: voice guide, anti-slop rules, product context, active version content, other asset summaries
- 150K token budget, oldest-first trimming
- Proposed content wrapped in `---PROPOSED---` delimiters for accept/reject

### 4. Quality Scoring (`src/services/quality/`)

**Central scorer** (`score-content.ts`):
- Runs all 5 scorers in parallel: slop, vendor-speak, authenticity, specificity, persona
- Each scorer has fallback to score 5 on failure
- `ScorerHealth` tracks which scorers succeeded/failed
- `checkQualityGates(scores, thresholds)` — all dimensions must pass
- `totalQualityScore(scores)` — composite score (inverts slop/vendor for comparison)

**Slop Detector** (`slop-detector.ts`):
- Pattern-based detection: hedging, transitions, fillers, fake enthusiasm, cliches
- AI-powered analysis via Gemini
- `deslop()` function rewrites content to remove detected patterns

**Grounding Validator** (`grounding-validator.ts`):
- Detects fabricated claims not supported by evidence
- Strips fabrications from generated content

### 5. AI Client Layer (`src/services/ai/`)

**`clients.ts`** — Unified client layer:
- `generateWithClaude(prompt, options)` — Claude API with rate limiting + retry
- `generateWithGemini(prompt, options)` — Gemini with Flash/Pro routing + rate limiting + retry
- `generateWithGeminiGroundedSearch(prompt, options)` — Gemini with Google Search tool (5x empty retry)
- `generateJSON<T>(prompt, options)` — Gemini Pro JSON generation with parse retry + error feedback
- `createDeepResearchInteraction(prompt)` — Async deep research submission
- `pollInteractionUntilComplete(interactionId)` — Poll with configurable interval/timeout

**Rate limiters**: Claude (10/min), Gemini Flash (60/min), Gemini Pro (15/min)

**`call-logger.ts`** — Fire-and-forget `logCall()` to `llm_calls` table  
**`call-context.ts`** — `withLLMContext()` for automatic session/job/purpose threading via AsyncLocalStorage

### 6. Product Insights (`src/services/product/insights.ts`)

- `extractInsights(productDocs)` — Gemini Flash extraction of domain, category, personas, capabilities, etc.
- `extractDeepPoV(productDocs)` — Gemini Pro deep point-of-view extraction (used by Standard pipeline)
- `buildFallbackInsights(productDocs)` — Deterministic fallback if extraction fails
- Formatting functions: `formatInsightsForScoring()`, `formatInsightsForPrompt()`, `formatInsightsForDiscovery()`, `formatInsightsForResearch()`

## Data Flow: Session Generation

```
User creates session (POST /api/workspace/sessions)
    │
    ├── createSession() → sessions table
    ├── autoNameSession() → placeholder name
    ├── startSessionGeneration()
    │       │
    │       ├── Build product docs string from pain point + docs + context
    │       ├── Create generation_jobs row
    │       ├── Update session status → 'generating'
    │       ├── Set MODEL_PROFILE env var
    │       └── Fire runPublicGenerationJob() (async, not awaited)
    │               │
    │               ├── loadJobInputs() → voices, asset types, pipeline
    │               ├── Resolve session for LLM context
    │               ├── withLLMContext() wraps pipeline
    │               └── PIPELINE_RUNNERS[pipeline](jobId, inputs)
    │                       │
    │                       ├── extractInsights() + nameSessionFromInsights()
    │                       ├── runCommunityDeepResearch() + runCompetitiveResearch()
    │                       ├── For each assetType × voice:
    │                       │     ├── buildSystemPrompt() + buildUserPrompt()
    │                       │     ├── generateContent()
    │                       │     ├── refinementLoop() → deslop → refine → score
    │                       │     └── storeVariant() → asset + variant + traceability
    │                       └── finalizeJob()
    │
    └── On completion:
            ├── Session status → 'completed'
            └── createInitialVersions() → session_versions (v1)
```

## Deployment

- **Server**: Hetzner VPS at 5.161.203.108
- **Process**: PM2 via `ecosystem.config.cjs`
- **Port**: 3007 (app) → 91 (nginx proxy)
- **Deploy**: `./deploy.sh` (npm install → build → admin build → git commit → PM2 restart)
- **Logs**: `data/dev-out.log`, `data/dev-error.log`
- **Database**: `data/messaging-engine.db` (SQLite)

## Testing

- **Framework**: Vitest with 5-minute timeout per test
- **Pool**: forks (single fork — SQLite isn't thread-safe)
- **Model profile**: Tests run with `MODEL_PROFILE=test` (all Gemini 2.5 Flash)

### Test Categories

**E2E** (`tests/e2e/`):
- `pipeline.test.ts` — Single pipeline end-to-end
- `all-pipelines.test.ts` — All 5 pipelines
- `community-evidence.test.ts` — Evidence grounding verification
- `spirit-scoring.ts` — LLM-based spirit validation helper

**Unit** (`tests/unit/`):
- `architecture/` — model-profile-guard, no-cron
- `auth/` — authentication tests
- `product/` — insights extraction
- `quality/` — gates, score-content, slop-detector, product-filter
- `workspace/` — versions, chat-context, naming, multi-voice, version-activation, adversarial-loop, go-outside-integrity, actions-integrity

**Integration** (`tests/integration/`):
- `naming-gemini.test.ts` — Session naming with real Gemini API

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
