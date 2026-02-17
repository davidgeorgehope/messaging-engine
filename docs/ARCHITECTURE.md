# Architecture

## Overview

The PMM Messaging Engine converts product documentation into scored, quality-tested messaging assets through specialized AI pipelines. It follows an "outside-in" philosophy — starting with real practitioner pain from developer communities rather than vendor features.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Hono (REST API), TypeScript |
| Frontend | Vite + React + Tailwind CSS |
| Database | SQLite + Drizzle ORM |
| AI Models | Gemini 3 Pro/Flash (production), Gemini 2.5 Flash (test) |

## File Structure

```
src/
├── api/
│   ├── generate.ts              # ~186 lines — route definitions + re-exports only
│   ├── validation.ts            # Zod schemas for all endpoints
│   ├── index.ts                 # Hono app + route mounting
│   ├── middleware/
│   │   ├── auth.ts              # JWT authentication (hard error on invalid)
│   │   └── rate-limit.ts        # Per-IP rate limiting
│   ├── admin/                   # Admin CRUD (settings, voices, documents)
│   └── workspace/               # Session management, chat, actions
├── config.ts                    # Model profiles, env config
├── types/index.ts               # Shared TypeScript interfaces (ScoringThresholds, PipelineStep, etc.)
├── services/
│   ├── pipeline/
│   │   ├── orchestrator.ts      # Job lifecycle, dispatch, generateAndScore, refinementLoop, storeVariant
│   │   ├── prompts.ts           # All prompt builders, templates, banned words, constants
│   │   ├── evidence.ts          # EvidenceBundle, community/competitive research
│   │   └── pipelines/
│   │       ├── standard.ts      # PoV-first with deep extraction
│   │       ├── outside-in.ts    # Community pain-first (signature pipeline)
│   │       ├── adversarial.ts   # Attack/defend generation
│   │       ├── multi-perspective.ts  # 3 angles + synthesis
│   │       └── straight-through.ts   # Score-only, no generation
│   ├── quality/
│   │   ├── score-content.ts     # 5 parallel scorers + health tracking
│   │   ├── slop-detector.ts     # AI cliché detection
│   │   ├── vendor-speak.ts      # Marketing jargon scorer
│   │   ├── authenticity.ts      # Authenticity scorer
│   │   ├── specificity.ts       # Specificity scorer
│   │   ├── persona-critic.ts    # Persona fit scorer
│   │   └── grounding-validator.ts # Strips fabricated quotes
│   ├── ai/
│   │   ├── clients.ts           # Gemini + Claude API wrappers
│   │   └── types.ts             # GenerateOptions, AIResponse
│   ├── product/insights.ts      # Insight extraction + deep PoV
│   ├── research/deep-research.ts # Gemini Deep Research agent
│   └── workspace/               # Sessions, chat, actions, versions
├── db/
│   ├── schema.ts                # Drizzle schema (14 tables)
│   ├── index.ts                 # DB connection
│   └── seed.ts                  # Default data
└── utils/                       # Logger, hash, retry
```

## Security

| Layer | Mechanism |
|-------|-----------|
| Authentication | JWT — hard error on invalid/missing token (no soft fallback) |
| Validation | Zod schemas on all request bodies (`validation.ts`) |
| Rate Limiting | Per-IP, per-path: configurable window + max requests |
| Input Limits | productDocs: 500K chars max, prompt: 10K chars max |

## Model Profile System

Two profiles controlled by `MODEL_PROFILE` env var:

| Task | Production | Test |
|------|-----------|------|
| flash | gemini-3-flash-preview | gemini-2.5-flash |
| pro | gemini-3-pro-preview | gemini-2.5-flash |
| deepResearch | deep-research-pro-preview-12-2025 | gemini-2.5-flash |
| generation | gemini-3-pro-preview | gemini-2.5-flash |
| scoring | gemini-3-flash-preview | gemini-2.5-flash |
| deslop | gemini-3-pro-preview | gemini-2.5-flash |

Test profile uses a single cheap model for all tasks — ideal for development and CI.

Every model call is logged with the actual model name and visible in the pipeline step UI via `emitPipelineStep()`.

## Rate Limiting

- Flash-tier endpoints: 60 requests/min per IP
- Pro-tier endpoints: 15 requests/min per IP
- In-memory store with automatic stale entry cleanup (5-min intervals)

## Quality Scoring System

5 independent scorers run in parallel via `Promise.all`:

| Scorer | Scale | Direction | What It Measures |
|--------|-------|-----------|-----------------|
| Slop | 0-10 | Lower is better | AI clichés, filler phrases |
| Vendor Speak | 0-10 | Lower is better | Marketing jargon, buzzwords |
| Authenticity | 0-10 | Higher is better | Genuine practitioner voice |
| Specificity | 0-10 | Higher is better | Concrete details vs vague claims |
| Persona | 0-10 | Higher is better | Fit with target persona (avg of critics) |

### Scorer Health & Degraded Mode

Each scoring run tracks health: `{ succeeded: N, failed: [...], total: 5 }`. If a scorer throws, it returns a neutral fallback score of 5 and the failure is logged. The system continues in degraded mode rather than failing the entire job.

### Quality Gates

Per-voice configurable thresholds (defaults):
- `slopMax: 5` — reject if slop score exceeds
- `vendorSpeakMax: 5` — reject if vendor speak exceeds
- `authenticityMin: 6` — reject if authenticity below
- `specificityMin: 6` — reject if specificity below
- `personaMin: 6` — reject if persona score below

## Pipeline Architecture

All pipelines share common orchestrator functions:
- `generateAndScore()` — generate content + score it
- `refinementLoop()` — iterative deslop → refine → rescore (up to 3 iterations, with plateau detection)
- `storeVariant()` — persist asset variant with scores and traceability
- `finalizeJob()` — mark job complete, emit final events

See [PIPELINE.md](PIPELINE.md) for detailed pipeline documentation.
