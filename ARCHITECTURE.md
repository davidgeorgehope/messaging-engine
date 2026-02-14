# Messaging Engine Architecture

## System Overview

The PMM Messaging Engine is an automated system that converts practitioner pain points discovered from community sources into scored, traceable messaging assets. It exists to solve a core product marketing problem: messaging that sounds like it was written by marketers rather than informed by real practitioner frustrations tends to fall flat. This engine closes the gap by grounding every messaging asset in actual community evidence, running it through competitive context, generating it with AI, and stress-testing it for quality before human review.

The system forks architectural patterns from two existing projects:

- **o11y.tips** (`/root/o11y.tips`) — Provides the discovery pipeline pattern (community source ingestion, scoring, scheduling), the quality pipeline pattern (multi-dimension scoring, quality gates), and the admin UI scaffold (Vite + React + Tailwind dashboard).
- **compintels** (`/root/compintels`) — Provides the competitive research pattern via Gemini Deep Research (async job submission, polling, structured result parsing).

By combining these two proven patterns with Claude-powered messaging generation and a voice profile system, the engine produces messaging assets that are evidence-based, competitively informed, voice-consistent, and quality-scored.

## Data Flow

```
+-------------------+     +-------------------+     +--------------------+
|  Community        |     |  Product          |     |  Competitive       |
|  Sources          |     |  Documents        |     |  Research          |
|  (Reddit, HN,    |     |  (PDFs, docs,     |     |  (Gemini Deep      |
|   Discourse,      |     |   release notes)  |     |   Research)        |
|   StackOverflow,  |     |                   |     |                    |
|   Discord)        |     +--------+----------+     +---------+----------+
+--------+----------+              |                          |
         |                         |                          |
         v                         |                          |
+--------+----------+              |                          |
|  Stage 1:         |              |                          |
|  Discovery        |              |                          |
|  - Source polling  |              |                          |
|  - Pain scoring   |              |                          |
|  - Quote extract  |              |                          |
+--------+----------+              |                          |
         |                         |                          |
         v                         v                          v
+--------+---------+------+--------+-----------+--------------+----------+
|                                                                        |
|                    Stage 4: Messaging Generation                       |
|                    (Claude)                                            |
|                                                                        |
|   Pain Points + Product Context + Competitive Intel + Voice Profile    |
|                           |                                            |
|                           v                                            |
|                  Generated Messaging Assets                            |
|   (battlecard, talk track, launch messaging, social hook,              |
|    one-pager, email copy)                                              |
|                                                                        |
+----------------------------+-------------------------------------------+
                             |
                             v
+----------------------------+-------------------------------------------+
|                                                                        |
|                    Stage 5: Scoring & Stress Testing                   |
|                    (Gemini Flash + Gemini Pro)                          |
|                                                                        |
|   5 Dimensions:                                                        |
|   [Slop] [Vendor-Speak] [Authenticity] [Specificity] [Persona-Fit]    |
|                           |                                            |
|                    Quality Gate Check                                   |
|                           |                                            |
|              +------------+------------+                               |
|              |                         |                               |
|           PASS                       FAIL                              |
|              |                         |                               |
|              v                         v                               |
|         Ready for              Flagged / Sent                          |
|         Review                 for Regeneration                        |
|                                                                        |
+----------------------------+-------------------------------------------+
                             |
                             v
+----------------------------+-------------------------------------------+
|                                                                        |
|                    Stage 6: Admin Review                               |
|                    (React Admin UI)                                    |
|                                                                        |
|              +------------+------------+                               |
|              |            |            |                               |
|           Approve      Edit &       Reject                             |
|              |         Rescore         |                               |
|              v            |            v                               |
|         Approved          |       Archived                             |
|         Assets       Re-enter                                          |
|              |        Pipeline                                         |
|              v                                                         |
|         Published Messaging Assets                                     |
|         (with full traceability chain)                                  |
|                                                                        |
+------------------------------------------------------------------------+
```

## Component Descriptions

### Service Layers

#### 1. Discovery Service (`src/services/discovery/`)

Forked from the o11y.tips discovery pipeline. Responsible for polling community sources on configurable schedules, extracting posts and comments that contain practitioner pain points, scoring them for relevance and severity, and extracting verbatim quotes for traceability. Each source has its own adapter (Reddit, Hacker News, Discourse, StackOverflow, Discord) with normalized output.

#### 2. Product Context Service (`src/services/product/`)

Manages uploaded product documents (PDFs, markdown, release notes, changelogs). These documents provide the factual grounding for messaging generation. The service handles upload, parsing, chunking, and retrieval so that the generation stage can pull relevant product facts for each pain point.

#### 3. Competitive Research Service (`src/services/research/`)

Adapted from the compintels project. Submits pain-point-focused research queries to Gemini Deep Research, polls for completion (async pattern), and parses structured results. The research is scoped to how competitors address (or fail to address) each discovered pain point, providing the competitive angle for messaging.

#### 4. Messaging Generation Service (`src/services/generation/`)

The core generation engine. Takes a pain point, product context, competitive research, and a voice profile, then uses Claude to generate messaging assets. Supports multiple asset types (battlecard, talk track, launch messaging, social hook, one-pager, email copy). Each generation job is tracked with full input/output lineage for traceability.

#### 5. Quality Pipeline Service (`src/services/quality/`)

Forked from the o11y.tips quality pipeline. Runs generated assets through 5 scoring dimensions using Gemini Flash (fast, cheap scoring) and Gemini Pro (slop detection via "deslop" rewrites). Each dimension produces a 0-100 score. Quality gates are configured per voice profile — e.g., a developer-focused voice might have a higher authenticity threshold than a marketing voice.

#### 6. Scheduling Service (`src/services/scheduler/`)

Uses node-cron to orchestrate recurring tasks: source discovery polling, research job polling, batch generation runs, and quality rescoring. Schedules are configurable per source and per pipeline stage via the admin UI.

#### 7. Auth Service (`src/services/auth/`)

JWT-based authentication for the admin UI and API endpoints. Supports user management and role-based access for the review/approve workflow.

### Infrastructure Layers

#### API Layer (`src/api/`)

Hono-based REST API. Routes are organized by domain: `/api/discovery`, `/api/research`, `/api/generation`, `/api/quality`, `/api/assets`, `/api/admin`. All endpoints return JSON and use consistent error handling middleware.

#### Database Layer (`src/db/`)

SQLite database managed through Drizzle ORM. The schema consists of 14 tables covering the full pipeline lifecycle. Drizzle provides type-safe queries, migrations, and schema definition in TypeScript. SQLite was chosen for simplicity and single-file deployment — the same pattern used successfully in o11y.tips.

#### AI Client Layer (`src/ai/`)

Abstraction layer for multi-model AI usage. Each model is wrapped in a client with retry logic, rate limiting, and structured output parsing:

- `gemini-flash.ts` — Fast scoring operations
- `gemini-pro.ts` — Slop detection and deslop rewrites
- `gemini-deep-research.ts` — Competitive research (async)
- `claude.ts` — Messaging generation

## Multi-Model AI Strategy

The engine uses a deliberate multi-model strategy, selecting each model for its strengths:

| Model | Purpose | Why This Model |
|-------|---------|----------------|
| **Gemini Flash** | Pain point scoring, quality dimension scoring | Fast, cheap, good at structured numeric output. Ideal for high-volume scoring where latency matters. |
| **Gemini Deep Research** | Competitive research | Unique capability — performs multi-step web research with source citations. No other model offers this as a built-in feature. |
| **Gemini Pro** | Slop detection, deslop rewrites | Better at nuanced language quality assessment than Flash. Used for the "deslop" pass where a rewrite may be needed. |
| **Claude** | Messaging generation | Superior at long-form, nuanced writing. Better at following complex voice profiles and producing natural-sounding marketing copy that avoids AI-typical patterns. |

This strategy optimizes for cost (Flash for volume), capability (Deep Research for web research), quality (Pro for language assessment), and creativity (Claude for generation).

## Database Overview

The database consists of 14 tables organized around the pipeline lifecycle. See `DATABASE.md` for the complete schema.

Core table groups:

- **Configuration**: `messaging_priorities`, `discovery_schedules`, `settings`, `voice_profiles`
- **Discovery**: `discovered_pain_points`
- **Product Context**: `product_documents`
- **Research**: `competitive_research`
- **Generation**: `generation_jobs`, `messaging_assets`, `asset_variants`
- **Quality**: `persona_critics`, `persona_scores`
- **Traceability**: `asset_traceability`, `messaging_gaps`

All tables use `TEXT` primary keys generated by `generateId()` (nanoid-style), ISO 8601 timestamps for all datetime fields, and `TEXT` columns with JSON serialization for complex nested data.

## Admin UI Overview

The admin UI is a Vite + React + Tailwind application with 10 pages, accessed via React Router:

1. **Dashboard** — Pipeline health, asset counts by status, recent activity, quality score distributions.
2. **Discovery** — View discovered pain points, filter by source/severity/status, manage discovery schedules.
3. **Pain Points** — Detailed pain point view with extracted quotes, related research, linked assets.
4. **Product Documents** — Upload and manage product documents, view parsed content, tag by product area.
5. **Research** — View competitive research results, trigger new research jobs, see research status.
6. **Generation** — Trigger generation jobs, select pain points and voice profiles, view generation queue.
7. **Assets** — Browse all messaging assets, filter by type/status/score, bulk actions.
8. **Asset Detail** — Single asset view with full traceability chain, scores, variants, approve/reject actions.
9. **Voice Profiles** — Create and manage voice profiles, set quality gate thresholds, preview voice characteristics.
10. **Settings** — System configuration, API keys, scheduler settings, user management.

## Voice Profile System

Voice profiles are a core concept that govern how messaging is generated and scored. A voice profile defines:

- **Name and description** — e.g., "Developer Advocate", "Enterprise Sales", "Product Launch"
- **Tone attributes** — Formality level, technical depth, empathy level, urgency
- **Vocabulary rules** — Preferred terms, banned terms, jargon handling
- **Quality gate thresholds** — Minimum scores per dimension that assets must meet for this voice
- **Example snippets** — Reference text that exemplifies the desired voice

During generation, the voice profile is injected into the Claude prompt so the output matches the desired tone and vocabulary. During scoring, the quality gates from the voice profile determine whether an asset passes or needs revision. This allows the same pain point to produce different messaging for different audiences (e.g., a developer-focused battlecard vs. an executive-focused one-pager) with appropriate quality bars for each.

## Traceability System (Killer Feature)

The traceability system is the defining feature of this engine. Every messaging asset maintains a complete, auditable chain back to its source evidence. The `asset_traceability` table records:

- **Source pain point** — The original community post/comment that surfaced the pain
- **Extracted quotes** — Verbatim practitioner language that grounds the message
- **Product documents used** — Which product facts informed the messaging
- **Competitive research used** — Which competitive insights were incorporated
- **Generation parameters** — The exact prompt, model, voice profile, and configuration used
- **Quality scores** — All dimension scores and which quality gates were applied
- **Edit history** — Any human edits made during review

This means any stakeholder can click on a messaging asset and trace it all the way back to a real practitioner saying a real thing in a real community. This transforms messaging from "the PMM team thinks X" to "practitioners are saying X, and here's the evidence." It also enables gap analysis: the `messaging_gaps` table tracks pain points that have been discovered but lack adequate messaging coverage, surfacing opportunities for new content.
