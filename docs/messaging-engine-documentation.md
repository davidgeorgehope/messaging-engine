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
