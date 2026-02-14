# Messaging Engine Implementation Plan

## Overview

This document outlines the phased build plan for the Messaging Engine. The project is structured into 8 phases with explicit dependencies between them. Each phase is self-contained and produces a testable, functional increment.

---

## Phase 1: Foundation

**Estimated Complexity**: Medium
**Estimated Duration**: 3-4 days
**Dependencies**: None (starting point)

### Objective

Set up the project structure, database, configuration system, shared utilities, and AI client abstractions. Everything else builds on this foundation.

### Tasks

#### 1.1 Project Setup
- Initialize Node.js + TypeScript project with `tsconfig.json`
- Configure ESLint, Prettier
- Set up path aliases (`@/` for `src/`)
- Create directory structure:
  ```
  src/
    api/           # Hono routes
    ai/            # AI client wrappers
    db/            # Drizzle schema and migrations
    services/      # Business logic
      discovery/
      product/
      research/
      generation/
      quality/
      scheduler/
      auth/
    utils/         # Shared utilities
    types/         # TypeScript type definitions
    config/        # Configuration management
  admin/           # Vite + React app (separate build)
  ```

#### 1.2 Database Setup
- Install and configure Drizzle ORM with SQLite (better-sqlite3)
- Define all 14 tables in `src/db/schema.ts` (see DATABASE.md)
- Set up Drizzle Kit for migrations (`drizzle.config.ts`)
- Generate and run initial migration
- Create `src/db/index.ts` with connection factory
- Create seed script for development data

#### 1.3 Configuration System
- Create `src/config/index.ts` with environment variable loading
- Support `.env` file via dotenv
- Define typed configuration interface:
  - `PORT`, `DATABASE_URL`, `JWT_SECRET`
  - `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`
  - `ADMIN_USERNAME`, `ADMIN_PASSWORD`
  - Default values for all optional settings
- Create settings service for runtime config from `settings` table

#### 1.4 Shared Utilities
- `src/utils/id.ts` — `generateId()` using nanoid (21 chars)
- `src/utils/timestamp.ts` — `now()` returning ISO 8601 string
- `src/utils/json.ts` — Safe JSON parse/stringify helpers for TEXT columns
- `src/utils/retry.ts` — Retry wrapper with exponential backoff for AI API calls
- `src/utils/rate-limit.ts` — Token bucket rate limiter for API calls
- `src/utils/logger.ts` — Structured logging (pino or console-based)
- `src/utils/errors.ts` — Custom error classes and error handling

#### 1.5 AI Client Abstractions
- `src/ai/gemini-flash.ts` — Gemini Flash client with structured output, retry, rate limiting
- `src/ai/gemini-pro.ts` — Gemini Pro client for deslop operations
- `src/ai/gemini-deep-research.ts` — Gemini Deep Research client with async job submission and polling
- `src/ai/claude.ts` — Claude client for messaging generation
- `src/ai/types.ts` — Shared AI response types
- Each client: configurable model ID, token tracking, error handling

#### 1.6 Hono API Scaffold
- `src/api/index.ts` — Hono app with middleware (CORS, JSON parsing, error handling, auth)
- `src/api/middleware/auth.ts` — JWT verification middleware
- `src/api/middleware/error.ts` — Global error handler
- Health check endpoint (`GET /api/health`)
- Server entry point (`src/index.ts`)

### Deliverables
- Working dev server that starts and responds to health checks
- Database created with all 14 tables
- All AI clients instantiable (not yet called)
- Utility functions tested

---

## Phase 2: Discovery Pipeline

**Estimated Complexity**: High
**Estimated Duration**: 4-5 days
**Dependencies**: Phase 1

### Objective

Implement the full discovery pipeline forked from o11y.tips: source adapters, pain point extraction, scoring, and scheduled polling.

### Tasks

#### 2.1 Source Adapters
- `src/services/discovery/adapters/reddit.ts` — Reddit API adapter (using public JSON endpoints or API)
- `src/services/discovery/adapters/hackernews.ts` — HN Algolia API adapter
- `src/services/discovery/adapters/discourse.ts` — Discourse API adapter (generic, configurable base URL)
- `src/services/discovery/adapters/stackoverflow.ts` — StackOverflow API adapter
- `src/services/discovery/adapters/discord.ts` — Discord API adapter (bot-based)
- `src/services/discovery/adapters/index.ts` — Adapter factory and shared interface
- Each adapter: fetch posts since last run, normalize to common format (`DiscoveredContent`)

#### 2.2 Pain Point Extraction
- `src/services/discovery/extractor.ts` — Pain point extraction service
- Sends filtered content to Gemini Flash with structured extraction prompt
- Extracts: pain summary, verbatim quotes, category, frequency indicator
- Handles batch processing (multiple posts per API call where possible)
- Prompt templates stored in `src/services/discovery/prompts/`

#### 2.3 Pain Point Scoring
- `src/services/discovery/scorer.ts` — Severity and relevance scoring
- Sends extracted pain points to Gemini Flash for 0-100 scoring on both dimensions
- Scoring prompt includes messaging priority keywords for relevance calibration
- Batch scoring support

#### 2.4 Deduplication
- `src/services/discovery/deduplicator.ts` — Deduplication by source URL and content similarity
- URL-based exact match
- Content-based similarity using normalized text comparison (Jaccard or similar lightweight approach)
- Near-duplicates linked, frequency indicator updated

#### 2.5 Discovery Orchestrator
- `src/services/discovery/orchestrator.ts` — Coordinates the full discovery flow:
  1. Fetch from source adapter
  2. Pre-filter by keywords
  3. Extract pain points
  4. Score pain points
  5. Deduplicate
  6. Store results
- Transaction-safe: entire batch succeeds or fails together

#### 2.6 Scheduler Integration
- `src/services/scheduler/index.ts` — node-cron scheduler setup
- Load discovery schedules from database
- Register cron jobs that invoke the discovery orchestrator
- Handle schedule changes (reload on update)
- Logging for all scheduled runs

#### 2.7 Discovery API
- `GET /api/discovery/schedules` — List all schedules
- `POST /api/discovery/schedules` — Create a schedule
- `PUT /api/discovery/schedules/:id` — Update a schedule
- `DELETE /api/discovery/schedules/:id` — Delete a schedule
- `POST /api/discovery/schedules/:id/run` — Trigger immediate run
- `GET /api/discovery/pain-points` — List pain points (filterable, paginated)
- `GET /api/discovery/pain-points/:id` — Get single pain point with details
- `PUT /api/discovery/pain-points/:id` — Update pain point status

### Deliverables
- Source adapters for all 5 platforms
- Pain point extraction and scoring working end-to-end
- Scheduled discovery running on cron
- API endpoints for managing schedules and viewing results

---

## Phase 3: Product Documents

**Estimated Complexity**: Low-Medium
**Estimated Duration**: 2-3 days
**Dependencies**: Phase 1

### Objective

Implement document upload, parsing, chunking, and retrieval for product context.

### Tasks

#### 3.1 Document Upload
- `src/services/product/upload.ts` — File upload handling
- Store files in `data/documents/` directory
- Support PDF, markdown, text, HTML formats
- File size validation (configurable max, default 10MB)
- Duplicate detection by file hash (SHA-256)

#### 3.2 Document Parsing
- `src/services/product/parser.ts` — Multi-format document parser
- PDF parsing via pdf-parse library
- Markdown/HTML to plain text extraction
- Plain text passthrough
- Error handling for corrupt or unparseable files

#### 3.3 Content Chunking
- `src/services/product/chunker.ts` — Content chunking for retrieval
- Split parsed content into overlapping chunks
- Configurable chunk size (default 1000 tokens) and overlap (default 200 tokens)
- Preserve paragraph boundaries where possible
- Store chunks as JSON array in `product_documents.chunks`

#### 3.4 Document Retrieval
- `src/services/product/retriever.ts` — Retrieve relevant chunks for a pain point
- Keyword-based matching: pain point keywords and category matched against chunk content
- Product area filtering
- Return top-N most relevant chunks (default 5)
- Scoring based on keyword overlap density

#### 3.5 Product Documents API
- `POST /api/documents` — Upload a document (multipart form)
- `GET /api/documents` — List all documents (filterable by product area, type)
- `GET /api/documents/:id` — Get single document with metadata
- `PUT /api/documents/:id` — Update document metadata
- `DELETE /api/documents/:id` — Archive a document
- `GET /api/documents/:id/chunks` — View parsed chunks

### Deliverables
- Document upload and parsing pipeline
- Chunk-based retrieval system
- API endpoints for document management

---

## Phase 4: Competitive Research

**Estimated Complexity**: Medium-High
**Estimated Duration**: 3-4 days
**Dependencies**: Phase 1, Phase 2 (for pain points to research)

### Objective

Implement the competitive research pipeline adapted from compintels: Gemini Deep Research integration with async polling, structured result parsing, and pain-point-focused query construction.

### Tasks

#### 4.1 Research Query Builder
- `src/services/research/query-builder.ts` — Constructs research queries from pain points
- Template: "How do [competitors] address [pain point]? What are their strengths, weaknesses, and gaps?"
- Incorporates messaging priority keywords for context
- Competitor names loaded from settings

#### 4.2 Deep Research Adapter
- `src/services/research/deep-research.ts` — Gemini Deep Research integration
- Submit research queries via API
- Receive job ID for async polling
- Poll for completion (configurable interval, default 30 seconds)
- Handle timeout (configurable, default 10 minutes)
- Handle rate limits and errors

#### 4.3 Result Parser
- `src/services/research/parser.ts` — Parse raw Deep Research responses
- Extract structured competitor positioning
- Identify competitive gaps
- Extract and validate cited sources
- Normalize competitor names across different phrasings
- Handle partial or incomplete research responses

#### 4.4 Research Orchestrator
- `src/services/research/orchestrator.ts` — Coordinate the full research flow:
  1. Identify pain points needing research (severity >= 60, relevance >= 60, no existing research)
  2. Build research queries
  3. Submit to Deep Research
  4. Poll for results (managed by scheduler)
  5. Parse and store results
- Batch submission with concurrency limits

#### 4.5 Research Scheduler
- Add research polling to the scheduler service
- Cron job to check for pending research jobs and poll for completion
- Cron job to identify new pain points eligible for research and submit queries
- Configurable concurrency (max simultaneous research jobs)

#### 4.6 Research API
- `GET /api/research` — List research results (filterable by status, pain point, competitor)
- `GET /api/research/:id` — Get single research result with full details
- `POST /api/research` — Trigger research for a specific pain point
- `POST /api/research/batch` — Trigger research for multiple pain points
- `GET /api/research/:id/status` — Poll research job status

### Deliverables
- Gemini Deep Research integration working end-to-end
- Async polling with scheduler
- Structured competitive intelligence extraction
- API endpoints for managing research

---

## Phase 5: Messaging Generation

**Estimated Complexity**: High
**Estimated Duration**: 4-5 days
**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4 (all input sources)

### Objective

Implement the core messaging generation engine: Claude-powered generation with voice profiles, multi-asset-type support, and full traceability recording.

### Tasks

#### 5.1 Voice Profile Management
- `src/services/generation/voice-profiles.ts` — Voice profile CRUD operations
- Default voice profiles for common use cases (Developer Advocate, Enterprise Sales, Product Launch)
- Validation of tone attributes, vocabulary rules, quality gates
- Voice profile API endpoints

#### 5.2 Prompt Templates
- `src/services/generation/prompts/` — Prompt templates per asset type
- `battlecard.ts` — Competitive comparison card prompt
- `talk-track.ts` — Sales conversation guide prompt
- `launch-messaging.ts` — Product launch copy prompt
- `social-hook.ts` — Social media post prompt
- `one-pager.ts` — Executive summary prompt
- `email-copy.ts` — Outbound email prompt
- Each template: system prompt, context injection points, format requirements, anti-slop instructions

#### 5.3 Context Assembler
- `src/services/generation/context-assembler.ts` — Assembles generation context
- Fetches pain point details and quotes
- Retrieves relevant product document chunks (from Phase 3)
- Retrieves competitive research findings (from Phase 4)
- Loads voice profile attributes
- Composes everything into a structured context object

#### 5.4 Generation Engine
- `src/services/generation/engine.ts` — Core generation logic
- Sends assembled prompts to Claude
- Handles per-asset-type generation (separate API calls)
- Configurable temperature, max tokens per asset type
- Response parsing and validation
- Token usage tracking

#### 5.5 Traceability Recorder
- `src/services/generation/traceability.ts` — Records full traceability chain
- Creates `asset_traceability` records linking assets to all inputs
- Records prompt hash, model parameters, timestamps
- Stores quotes used, product facts used, competitive claims used

#### 5.6 Generation Orchestrator
- `src/services/generation/orchestrator.ts` — Coordinates the full generation flow:
  1. Create generation job
  2. Assemble context
  3. Generate assets for each requested type
  4. Record traceability
  5. Update job status
- Support for batch generation (multiple pain points in one job)
- Error handling and partial completion support

#### 5.7 Generation API
- `POST /api/generation/jobs` — Create a generation job
- `GET /api/generation/jobs` — List generation jobs (filterable)
- `GET /api/generation/jobs/:id` — Get job status and results
- `POST /api/generation/jobs/:id/cancel` — Cancel a running job
- `GET /api/generation/voice-profiles` — List voice profiles
- `POST /api/generation/voice-profiles` — Create a voice profile
- `PUT /api/generation/voice-profiles/:id` — Update a voice profile
- `DELETE /api/generation/voice-profiles/:id` — Archive a voice profile

### Deliverables
- Claude-powered generation for all 6 asset types
- Voice profile system working
- Full traceability recording
- API endpoints for generation and voice profile management

---

## Phase 6: Quality Pipeline

**Estimated Complexity**: High
**Estimated Duration**: 4-5 days
**Dependencies**: Phase 1, Phase 5 (for assets to score)

### Objective

Implement the quality scoring pipeline forked from o11y.tips: persona critics, 5-dimension scoring, quality gates, and the deslop pass.

### Tasks

#### 6.1 Persona Critics Management
- `src/services/quality/critics.ts` — Persona critic CRUD
- Default critics: Skeptical SRE, Time-Pressed VP of Eng, Junior Developer, Competitive Analyst
- Critic scoring prompts with dimension-specific evaluation criteria
- Weight configuration

#### 6.2 Scoring Dimensions
- `src/services/quality/dimensions/slop.ts` — Slop detection scoring (inverted: high = clean)
- `src/services/quality/dimensions/vendor-speak.ts` — Vendor-speak detection (inverted: high = practitioner-focused)
- `src/services/quality/dimensions/authenticity.ts` — Authenticity scoring (does it sound human?)
- `src/services/quality/dimensions/specificity.ts` — Specificity scoring (concrete vs. vague)
- `src/services/quality/dimensions/persona-fit.ts` — Persona-fit scoring (resonates with target?)
- Each dimension: evaluation criteria, scoring prompt template, examples of high/low scores

#### 6.3 Scoring Engine
- `src/services/quality/scorer.ts` — Core scoring engine
- Iterates: for each (asset, critic, dimension), call Gemini Flash for scoring
- Structured output: score (0-100), reasoning (text), suggestions (array)
- Batch scoring for efficiency
- Store all scores in `persona_scores`

#### 6.4 Deslop Pass
- `src/services/quality/deslop.ts` — Slop detection and rewrite
- Trigger: slop score below threshold (default 60) from any critic
- Send to Gemini Pro with: original content, slop feedback, rewrite instructions
- Store result as `asset_variants` with `variant_type = 'deslop'`
- Re-score the deslopped version

#### 6.5 Quality Gate Evaluator
- `src/services/quality/gates.ts` — Quality gate evaluation
- Load quality gate thresholds from voice profile
- Calculate per-dimension averages across all critics
- Determine pass/fail per dimension and overall
- Update `messaging_assets.overall_score` and `passed_quality_gate`

#### 6.6 Quality Orchestrator
- `src/services/quality/orchestrator.ts` — Coordinate the full quality flow:
  1. Identify assets needing scoring (status `draft`)
  2. Run all (critic, dimension) scoring combinations
  3. Check for slop failures, run deslop if needed
  4. Evaluate quality gates
  5. Update asset status to `scored`
- Scheduler integration for automatic scoring of new assets

#### 6.7 Quality API
- `GET /api/quality/critics` — List persona critics
- `POST /api/quality/critics` — Create a critic
- `PUT /api/quality/critics/:id` — Update a critic
- `GET /api/quality/scores/:assetId` — Get all scores for an asset
- `POST /api/quality/score/:assetId` — Trigger scoring for a specific asset
- `POST /api/quality/deslop/:assetId` — Trigger deslop for a specific asset
- `GET /api/quality/stats` — Quality statistics across all assets

### Deliverables
- 5-dimension scoring system working end-to-end
- Persona critic system
- Deslop pass with variant creation
- Quality gate evaluation
- API endpoints for quality management

---

## Phase 7: Admin UI

**Estimated Complexity**: High
**Estimated Duration**: 5-7 days
**Dependencies**: Phase 1-6 (all APIs must be available)

### Objective

Build the admin UI with Vite + React + React Router + Tailwind CSS. All 10 pages with full functionality.

### Tasks

#### 7.1 UI Scaffold
- Initialize Vite + React + TypeScript project in `admin/`
- Configure Tailwind CSS
- Set up React Router with route definitions
- Create layout components (sidebar navigation, header, main content area)
- API client with JWT auth and fetch wrapper
- Shared UI components (tables, cards, badges, buttons, forms, modals)

#### 7.2 Authentication
- Login page with JWT token management
- Token storage in localStorage
- Auto-redirect on auth expiration
- Protected route wrapper

#### 7.3 Dashboard Page
- Pipeline health overview (last run times, error rates)
- Asset counts by status (draft, scoring, scored, in_review, approved, rejected)
- Recent activity feed
- Quality score distribution chart
- Messaging gap count
- Quick action buttons (trigger discovery, trigger scoring)

#### 7.4 Discovery Page
- Discovery schedule list with enable/disable toggles
- Create/edit schedule form (source type, config, cron expression, priority link)
- Trigger immediate run button
- Schedule run history with error display
- Discovered pain points list with filters (source, severity, status, date range)

#### 7.5 Pain Points Page
- Detailed pain point view
- Extracted quotes display (highlighted verbatim text)
- Severity and relevance score visualization
- Related competitive research links
- Linked messaging assets
- Status management (validate, archive, mark irrelevant)

#### 7.6 Product Documents Page
- Document upload form with drag-and-drop
- Document list with filters (product area, type, status)
- Document detail view with parsed content preview
- Chunk viewer
- Edit metadata, archive documents

#### 7.7 Research Page
- Research results list with status indicators
- Trigger new research (select pain point and competitors)
- Research detail view with structured findings
- Competitor positioning visualization
- Identified gaps display
- Source citations with links

#### 7.8 Generation Page
- Generation job creation wizard:
  1. Select pain points
  2. Select voice profile
  3. Select asset types
  4. Optionally select product docs and research
  5. Review and submit
- Generation job queue with status tracking
- Job detail view with generated assets

#### 7.9 Assets Page
- Asset list with comprehensive filters (type, status, score range, voice, priority)
- Sort by score, date, status
- Bulk approve/reject actions
- Quick score preview (color-coded badges)
- Asset type icons

#### 7.10 Asset Detail Page
- Full asset content display with markdown rendering
- Score breakdown visualization (radar chart or bar chart per dimension)
- Per-critic score details with reasoning and suggestions
- Quality gate pass/fail indicators
- Full traceability chain:
  - Source pain points (with links to originals)
  - Verbatim quotes used
  - Product documents used
  - Competitive research used
  - Generation parameters
- Variant list with side-by-side comparison
- Review action buttons: Approve, Edit, Regenerate, Reject, Archive
- Reviewer notes field

#### 7.11 Voice Profiles Page
- Voice profile list with key attributes
- Create/edit voice profile form:
  - Name, description
  - Tone attribute sliders (formality, technical depth, empathy, urgency)
  - Vocabulary rules (preferred terms, banned terms, jargon policy)
  - Quality gate thresholds per dimension
  - Example snippets
- Preview voice characteristics
- Default profile toggle

#### 7.12 Settings Page
- System configuration editor (grouped by category)
- API key management (masked display for secrets)
- Scheduler configuration
- User management (create, edit, disable users)
- System health checks (AI API connectivity, database status)

### Deliverables
- Complete admin UI with all 10 pages
- Authentication flow
- All CRUD operations working through the API
- Responsive layout

---

## Phase 8: Integration & Testing

**Estimated Complexity**: Medium
**Estimated Duration**: 3-4 days
**Dependencies**: Phase 1-7 (all components built)

### Tasks

#### 8.1 End-to-End Pipeline Testing
- Test complete flow: source discovery through approved asset
- Verify traceability chain completeness at each stage
- Test with real community sources (Reddit, HN)
- Validate scoring produces meaningful differentiation

#### 8.2 Error Handling & Recovery
- Test AI API failures and retry behavior
- Test scheduler failure recovery
- Test partial generation completion
- Test database transaction rollbacks
- Add circuit breaker patterns for AI APIs

#### 8.3 Performance Testing
- Benchmark discovery polling with multiple sources
- Benchmark batch scoring (100+ assets)
- Benchmark admin UI page load times
- Identify and optimize slow database queries
- Add pagination to all list endpoints

#### 8.4 Security Review
- Validate JWT implementation
- Ensure API key masking in all responses
- Check for SQL injection (Drizzle should prevent this, but verify)
- CORS configuration review
- Rate limiting on auth endpoints

#### 8.5 Documentation & Cleanup
- API documentation (OpenAPI/Swagger or markdown)
- Environment setup guide
- Deployment instructions
- Code cleanup, remove dead code
- Final review of all CLAUDE.md instructions

---

## Dependency Graph

```
Phase 1: Foundation
    |
    +---> Phase 2: Discovery Pipeline
    |         |
    |         +---> Phase 4: Competitive Research
    |         |         |
    +---> Phase 3: Product Documents
    |         |         |
    |         +---------+---> Phase 5: Messaging Generation
    |                             |
    |                             +---> Phase 6: Quality Pipeline
    |                                       |
    +---------------------------------------+---> Phase 7: Admin UI
                                                      |
                                                      +---> Phase 8: Integration & Testing
```

**Critical path**: Phase 1 -> Phase 2 -> Phase 5 -> Phase 6 -> Phase 7 -> Phase 8

**Parallel work opportunities**:
- Phase 2 (Discovery) and Phase 3 (Product Documents) can be built in parallel after Phase 1
- Phase 4 (Competitive Research) can start as soon as Phase 2 is complete, in parallel with Phase 3
- Phase 7 (Admin UI) pages can be built incrementally as their backing APIs become available

---

## Complexity Summary

| Phase | Complexity | Duration | Key Risk |
|-------|-----------|----------|----------|
| Phase 1: Foundation | Medium | 3-4 days | Getting Drizzle + SQLite + 14 tables right |
| Phase 2: Discovery | High | 4-5 days | Source API reliability and rate limits |
| Phase 3: Product Docs | Low-Medium | 2-3 days | PDF parsing edge cases |
| Phase 4: Research | Medium-High | 3-4 days | Gemini Deep Research API async handling |
| Phase 5: Generation | High | 4-5 days | Prompt engineering for 6 asset types |
| Phase 6: Quality | High | 4-5 days | Calibrating scoring to produce meaningful results |
| Phase 7: Admin UI | High | 5-7 days | 10 pages with complex interactions |
| Phase 8: Integration | Medium | 3-4 days | End-to-end flow reliability |
| **Total** | | **28-37 days** | |
