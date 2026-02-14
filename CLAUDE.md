# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

This is the **PMM Messaging Engine**, an automated system that converts practitioner pain points discovered from community sources into scored, traceable messaging assets. It forks patterns from two existing projects and combines them with AI-powered generation (Gemini by default) and a voice profile system.

**Core value proposition**: Every messaging asset is grounded in real community evidence, enriched with competitive intelligence, generated in a controlled voice, stress-tested for quality, and fully traceable back to its source.

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Backend**: Hono (lightweight, fast, edge-compatible web framework)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Admin UI**: Vite + React + React Router + Tailwind CSS (in `admin/` directory)
- **AI Models**: Gemini Flash (scoring), Gemini Pro (generation, deslop), Gemini Deep Research (community/competitive research), Claude (optional override)
- **Scheduler**: node-cron
- **Auth**: JWT (jsonwebtoken)
- **IDs**: nanoid (21-character string IDs)

## Source Project References

This project forks patterns from two existing codebases. Refer to them for implementation patterns:

- **o11y.tips** at `/root/o11y.tips` — Source for the discovery pipeline (source adapters, scheduling, pain point extraction), the quality pipeline (multi-dimension scoring, persona critics, quality gates), the admin UI scaffold (Vite + React + Tailwind layout, page structure), and the settings/config pattern. When building discovery or quality features, check the o11y.tips implementation first.

- **compintels** at `/root/compintels` — Source for the competitive research pipeline via Gemini Deep Research (async job submission, polling, structured result parsing). When building the research service, check the compintels implementation first.

## Key Architectural Decisions

1. **SQLite over PostgreSQL**: Single-file database for simplicity. This is an internal PMM tool, not a high-concurrency production service. The o11y.tips project proved this works well for this class of application.

2. **Multi-model AI strategy**: Each model is selected for its specific strength. Do not consolidate to a single model. See the model table below.

3. **JSON in TEXT columns**: Complex nested data (arrays, objects) is stored as JSON-serialized TEXT columns in SQLite. This avoids junction tables for many-to-many relationships. Always use `JSON.parse()` on read and `JSON.stringify()` on write.

4. **Traceability as first-class concern**: Every messaging asset must have a complete `asset_traceability` record. Never generate an asset without recording its full input chain.

5. **Voice profiles drive quality gates**: Quality scoring thresholds are per-voice-profile, not global. A developer audience voice has different quality bars than an executive audience voice.

6. **Async research**: Gemini Deep Research is inherently async (jobs take 1-5 minutes). The system submits jobs and polls for results via the scheduler, never blocking.

## Database

- **ORM**: Drizzle with better-sqlite3 driver
- **Schema**: `src/db/schema.ts` — 14 tables
- **Migrations**: Managed by Drizzle Kit (`drizzle.config.ts`)
- **Connection**: `src/db/index.ts`

### 14 Tables

1. `messaging_priorities` — Strategic messaging themes
2. `discovery_schedules` — Source polling configuration
3. `discovered_pain_points` — Extracted pain points from community sources
4. `generation_jobs` — Messaging generation job tracking
5. `settings` — Key-value system configuration
6. `product_documents` — Uploaded product context documents
7. `messaging_assets` — Generated messaging assets (the primary output)
8. `persona_critics` — AI critic personas for quality scoring
9. `persona_scores` — Individual scores per (asset, critic, dimension)
10. `competitive_research` — Gemini Deep Research results
11. `asset_traceability` — Full evidence chain for each asset
12. `messaging_gaps` — Identified messaging coverage gaps
13. `voice_profiles` — Voice/tone profiles for generation and scoring
14. `asset_variants` — Alternate versions of assets (deslop, regeneration, edits)

See `DATABASE.md` for complete schema with all fields, types, and constraints.

## Multi-Model AI Usage

| Model | Client File | Used For | When to Choose |
|-------|-------------|----------|----------------|
| **Gemini Flash** | `src/ai/gemini-flash.ts` | Pain point extraction, severity/relevance scoring, quality dimension scoring, session naming | High-volume, structured output, cost-sensitive operations |
| **Gemini Pro** | `src/ai/gemini-pro.ts` | Messaging generation (all asset types), slop detection, deslop rewrites | Default model for all generation and quality tasks |
| **Gemini Deep Research** | `src/ai/gemini-deep-research.ts` | Community and competitive research | Multi-step web research with source citations (async) |
| **Claude** | `src/ai/claude.ts` | Available as optional override when explicitly selected | Only used when user picks Claude in the UI |

**Default model is Gemini.** Claude is only used when explicitly selected (model string contains 'claude'). Do not default to Claude anywhere.

**Rule of thumb**: Gemini is the default for everything. Flash for scoring/classifying, Pro for generation/rewriting, Deep Research for web research. Claude is an opt-in override only.

**Token limits**: Do not hardcode `maxTokens` unless you need more than the 8192 default. Newer models have much higher token limits, and low hardcoded values cause silent truncation.

**JSON generation resilience**: `generateJSON()` in `src/services/ai/clients.ts` retries with error feedback on parse failures — it sends the parse error and broken response back to the model so it can self-correct (up to `maxParseRetries` attempts).

## Voice Profile System

Voice profiles (`voice_profiles` table) define:
- **Tone attributes**: `{formality, technical_depth, empathy, urgency}` each 0-100
- **Vocabulary rules**: `{preferred_terms[], banned_terms[], jargon_policy}`
- **Quality gates**: `{slop: min, vendor_speak: min, authenticity: min, specificity: min, persona_fit: min}`
- **Example snippets**: Reference text exemplifying the voice
- **System prompt prefix**: Additional instructions injected into generation prompts

Voice profiles are injected into generation prompts and used as the thresholds for quality gate evaluation. An asset passes quality gates only if it meets all dimension minimums defined by its voice profile.

## Quality Gates

5 scoring dimensions, each 0-100:
1. **Slop** (inverted) — Low AI cliches and filler language. High = clean.
2. **Vendor-Speak** (inverted) — Low self-congratulatory vendor language. High = practitioner-focused.
3. **Authenticity** — Sounds like a real human wrote it.
4. **Specificity** — Uses concrete details, not vague generalities.
5. **Persona-Fit** — Resonates with the target persona.

Each dimension is scored by multiple persona critics. The per-dimension average across critics is compared against the voice profile's quality gate thresholds. All dimensions must pass for `passed_quality_gate = 1`.

## Key File Locations

```
src/
  index.ts                              # Server entry point
  config.ts                             # Configuration management
  db/
    schema.ts                           # All 14 table definitions
    index.ts                            # Database connection
  ai/
    gemini-flash.ts                     # Gemini Flash client
    gemini-pro.ts                       # Gemini Pro client
    gemini-deep-research.ts             # Gemini Deep Research client
    claude.ts                           # Claude client
    types.ts                            # Shared AI types
  api/
    index.ts                            # Hono app and route registration
    middleware/auth.ts                   # JWT auth middleware
    middleware/error.ts                  # Error handling middleware
  services/
    discovery/
      orchestrator.ts                   # Discovery pipeline coordinator
      adapters/                         # Source adapters (reddit, hn, etc.)
      extractor.ts                      # Pain point extraction
      scorer.ts                         # Severity/relevance scoring
      deduplicator.ts                   # Deduplication logic
      prompts/                          # Discovery prompt templates
    product/
      upload.ts                         # Document upload handling
      parser.ts                         # Multi-format document parsing
      chunker.ts                        # Content chunking
      retriever.ts                      # Relevant chunk retrieval
    research/
      orchestrator.ts                   # Research pipeline coordinator
      deep-research.ts                  # Gemini Deep Research adapter
      query-builder.ts                  # Research query construction
      parser.ts                         # Research result parsing
    generation/
      orchestrator.ts                   # Generation pipeline coordinator
      engine.ts                         # Core generation logic
      context-assembler.ts              # Context assembly for prompts
      traceability.ts                   # Traceability recording
      voice-profiles.ts                 # Voice profile management
      prompts/                          # Per-asset-type prompt templates
    quality/
      orchestrator.ts                   # Quality pipeline coordinator
      scorer.ts                         # Multi-dimension scoring engine
      gates.ts                          # Quality gate evaluator
      deslop.ts                         # Slop detection and rewrite
      critics.ts                        # Persona critic management
      dimensions/                       # Per-dimension scoring logic
    scheduler/index.ts                  # node-cron scheduler
    auth/index.ts                       # JWT auth service
  utils/
    id.ts                               # generateId() — nanoid
    timestamp.ts                        # now() — ISO 8601
    json.ts                             # Safe JSON parse/stringify
    retry.ts                            # Retry with exponential backoff
    rate-limit.ts                       # Token bucket rate limiter
    logger.ts                           # Structured logging
    errors.ts                           # Custom error classes
  types/                                # Shared TypeScript types

templates/                                # Markdown prompt templates per asset type
  battlecard.md
  talk-track.md
  launch-messaging.md
  social-hook.md
  one-pager.md
  email-copy.md
  messaging-template.md                  # Comprehensive positioning document
  narrative.md                            # 3-variant storytelling

tests/
  e2e/pipeline.test.ts                    # End-to-end pipeline test

vitest.config.ts                          # Vitest configuration
ecosystem.config.cjs                      # pm2 process config

admin/                                  # Vite + React admin UI
  src/
    pages/                              # 10 page components
    components/                         # Shared UI components
    hooks/                              # Custom React hooks
    api/                                # API client
    App.tsx                             # Router setup
    main.tsx                            # Entry point
```

## Common Tasks

### Adding a New Community Source

1. Create a new adapter in `src/services/discovery/adapters/` following the existing adapter pattern
2. Implement the `SourceAdapter` interface: `fetchSince(lastRunAt: string): Promise<DiscoveredContent[]>`
3. Register the adapter in `src/services/discovery/adapters/index.ts` factory
4. Add the source type string to the `source_type` union in the schema
5. Add source-specific configuration validation
6. Test with a manual run via `POST /api/discovery/schedules/:id/run`

### Adding a New Asset Type

1. Create a new prompt template in `src/services/generation/prompts/` (e.g., `webinar-script.ts`)
2. Follow the existing template pattern: system prompt, context sections, format requirements, anti-slop instructions
3. Add the asset type string to the `asset_type` union in the schema
4. Register in the generation engine's type dispatch
5. Define default max tokens and format expectations for the new type
6. Add the type to the admin UI's asset type filter and generation wizard

### Adding a New Scoring Dimension

1. Create a new dimension file in `src/services/quality/dimensions/` (e.g., `urgency.ts`)
2. Define evaluation criteria, scoring prompt template, and examples of high/low scores
3. Add the dimension string to the `dimension` union in the schema
4. Add the dimension to the quality gate evaluator in `src/services/quality/gates.ts`
5. Add a default threshold for the new dimension in voice profile quality gates
6. Update the admin UI's score visualization to include the new dimension

### Adding a New Persona Critic

1. Insert a new row into `persona_critics` via the admin UI or API
2. Define: name, role, perspective, scoring prompt, weight
3. The scoring engine automatically includes all active critics — no code changes needed
4. Consider adjusting weights if the new critic should have more or less influence

## Environment Setup

### Prerequisites

- Node.js 20+
- npm or pnpm

### Installation

```bash
cd /root/messaging-engine
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your API keys:
#   GEMINI_API_KEY=...
#   ANTHROPIC_API_KEY=...
#   JWT_SECRET=...
#   ADMIN_USERNAME=admin
#   ADMIN_PASSWORD=...

# Run database migrations
npx drizzle-kit push

# Seed development data (optional)
npm run seed

# Start development server via pm2
pm2 start ecosystem.config.cjs

# Other pm2 commands
pm2 stop messaging-engine
pm2 restart messaging-engine
pm2 logs messaging-engine
pm2 status

# Run tests
npm test              # unit tests
npm run test:e2e      # end-to-end pipeline test (long-running)

# In a separate terminal, start the admin UI
cd admin
npm install
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default: 3007) | API server port (nginx proxies from port 91) |
| `DATABASE_URL` | No (default: ./data/messaging-engine.db) | SQLite database file path |
| `GEMINI_API_KEY` | Yes | Google AI API key for Gemini models |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `JWT_SECRET` | Yes | Secret for JWT token signing |
| `ADMIN_USERNAME` | Yes | Default admin username |
| `ADMIN_PASSWORD` | Yes | Default admin password |
| `LOG_LEVEL` | No (default: info) | Logging level (debug, info, warn, error) |
| `NODE_ENV` | No (default: development) | Environment (development, production) |

## Important Conventions

### IDs
Always use `generateId()` from `src/utils/id.ts` for primary keys. Never use auto-increment integers. IDs are 21-character nanoid strings stored as TEXT.

### Timestamps
Always use `now()` from `src/utils/timestamp.ts` which returns `new Date().toISOString()`. All datetime columns are TEXT with ISO 8601 format. Never use Unix timestamps or Date objects in the database.

### JSON Columns
Complex data (arrays, objects) is stored as JSON-serialized TEXT. Always use `safeJsonParse()` from `src/utils/json.ts` on read (handles null/undefined gracefully) and `JSON.stringify()` on write. Define TypeScript types for the JSON structure and cast on parse.

### Error Handling
Use custom error classes from `src/utils/errors.ts`. The global error handler in `src/api/middleware/error.ts` catches all errors and returns consistent JSON responses. AI API errors should be retried using the retry utility before surfacing.

### API Response Format
All API endpoints return JSON with consistent structure:
```typescript
// Success
{ data: T, meta?: { page, limit, total } }

// Error
{ error: { code: string, message: string, details?: any } }
```

### Database Queries
Always use Drizzle's query builder. Never write raw SQL. Use transactions for multi-table operations. Always include `updated_at: now()` when updating rows.

### AI Prompts
Store prompt templates as TypeScript template literal functions in the relevant `prompts/` directory. Prompts should be composable (system prompt + context sections). Always include anti-slop instructions in generation prompts. Always request structured JSON output for scoring operations.
