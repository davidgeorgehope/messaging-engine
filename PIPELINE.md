# Messaging Engine Pipeline

## Overview

The pipeline consists of 6 stages that transform raw community signals into reviewed, approved messaging assets. Each stage has defined inputs, outputs, AI models used, and quality checks. The stages can run independently (a pain point does not need to wait for research before generation can begin) but produce the best results when the full chain is populated.

---

## Stage 1: Discovery

**Forked from**: o11y.tips discovery pipeline

### Purpose

Poll community sources on configurable schedules, identify practitioner pain points, score them for severity and relevance, and extract verbatim quotes for downstream traceability.

### Input

- Configured discovery schedules (source type, source config, cron expression)
- Messaging priorities (keywords, target personas) for relevance matching
- Community source APIs (Reddit, Hacker News, Discourse, StackOverflow, Discord)

### Process

1. **Source Polling**: The scheduler triggers each discovery schedule according to its cron expression. The source adapter for the given platform (e.g., Reddit adapter) calls the platform API and retrieves new posts/comments since `last_run_at`.

2. **Content Filtering**: Raw posts are filtered for minimum length, language (English), and basic relevance heuristics (keyword matching against messaging priority keywords). This is a cheap pre-filter to avoid burning AI tokens on irrelevant content.

3. **Pain Point Extraction**: Posts that pass the pre-filter are sent to Gemini Flash with a structured prompt that asks:
   - Is this post expressing a pain point related to [product area]?
   - What is the core pain being described?
   - Extract up to 3 verbatim quotes that best capture the pain.
   - Categorize the pain (complexity, cost, reliability, performance, tooling, etc.).
   - Estimate frequency: isolated, recurring, or widespread.

4. **Scoring**: Each extracted pain point is scored on two dimensions by Gemini Flash:
   - **Severity** (0-100): How painful is this for the practitioner? A minor annoyance scores low; a blocking production issue scores high.
   - **Relevance** (0-100): How relevant is this to our product's positioning? A pain we can directly address scores high; a tangential pain scores low.

5. **Deduplication**: New pain points are compared against existing ones (by source URL and semantic similarity) to avoid duplicates. Near-duplicates are linked and the frequency indicator is updated.

6. **Storage**: Validated pain points are stored in `discovered_pain_points` with all extracted metadata, quotes, and scores.

### Output

- `discovered_pain_points` rows with status `new`
- Each row includes: extracted pain summary, verbatim quotes, severity score, relevance score, pain category, frequency indicator

### Model Used

- **Gemini Flash** for extraction, scoring, and categorization

### Quality Checks

- Minimum severity threshold (configurable, default 30) — pain points below this are auto-archived
- Minimum relevance threshold (configurable, default 40) — irrelevant content is auto-archived
- Deduplication check against existing pain points
- Source URL uniqueness constraint

---

## Stage 2: Product Context

### Purpose

Upload, parse, and manage product documents that provide factual grounding for messaging generation. Without product context, generated messaging risks being generic or inaccurate.

### Input

- Product documents uploaded via the admin UI (PDF, markdown, text, HTML)
- Document metadata: name, product area, document type, version

### Process

1. **Upload & Storage**: Documents are uploaded via the admin UI, stored on disk, and registered in the `product_documents` table.

2. **Parsing**: Each document is parsed based on its file type:
   - PDF: Text extraction via pdf-parse
   - Markdown/HTML: Direct text extraction with formatting preserved
   - Plain text: Stored as-is

3. **Chunking**: Parsed content is split into overlapping chunks (default 1000 tokens with 200 token overlap) for retrieval. Chunks are stored as a JSON array in the `chunks` column.

4. **Tagging**: Documents are tagged by product area and document type for filtered retrieval during generation.

5. **Retrieval**: During generation (Stage 4), the system retrieves relevant chunks by matching the pain point's category and keywords against document product areas and content. This is a keyword-based retrieval (not vector search) to keep the system simple and dependency-light.

### Output

- `product_documents` rows with parsed content and chunks
- Chunks available for retrieval during generation

### Model Used

- None (parsing and chunking are rule-based)

### Quality Checks

- Parse success validation (non-empty parsed content)
- Chunk size validation
- Duplicate document detection (by file hash)

---

## Stage 3: Competitive Research

**Adapted from**: compintels competitive research pipeline

### Purpose

For each high-priority pain point (or messaging priority), conduct automated competitive research using Gemini Deep Research to understand how competitors address (or fail to address) the same pain. This competitive context makes generated messaging sharper and more differentiated.

### Input

- Discovered pain points (typically those with severity >= 60 and relevance >= 60)
- Messaging priorities
- Competitor names (configured in settings)

### Process

1. **Query Construction**: A research query is assembled from the pain point's extracted pain, category, and related messaging priority keywords. The query is structured as: "How do [competitor names] address [pain point description]? What are their strengths, weaknesses, and gaps in addressing this problem for [target persona]?"

2. **Job Submission**: The query is submitted to the Gemini Deep Research API. This is an asynchronous operation — the API returns a job ID immediately.

3. **Polling**: The scheduler polls the Gemini Deep Research API for job completion. Research jobs can take 1-5 minutes. Polling occurs every 30 seconds. After 10 minutes, the job is marked as `expired`.

4. **Result Parsing**: When complete, the raw research response is parsed into structured findings:
   - `competitor_positioning`: For each competitor, how they position against this pain
   - `gaps_identified`: Competitive gaps where no competitor addresses the pain well
   - `sources_cited`: URLs of sources the research referenced
   - `parsed_findings`: Structured summary of key findings

5. **Storage**: Results are stored in `competitive_research` with all structured and raw data.

### Output

- `competitive_research` rows with status `completed`
- Structured competitive positioning, gaps, and citations
- Available for injection into generation prompts

### Model Used

- **Gemini Deep Research** for web-scale competitive research

### Quality Checks

- Research job completion within timeout (10 minutes)
- Minimum number of sources cited (at least 3)
- Parsed findings non-empty validation
- Competitor name matching validation (research actually discusses named competitors)

---

## Stage 4: Messaging Generation (Pipeline Variants)

### Purpose

The core generation stage. Takes product docs (or pain points), combines with research and voice profiles, and generates messaging through one of four pipeline variants. All pipelines end with a shared **refinement loop** that iteratively improves content until quality gates pass.

### Available Pipelines

#### Standard Pipeline
Sequential DAG: Extract Insights → Research (community + competitive, parallel) → Generate → Refinement Loop → Store

The default pipeline. Extracts product insights, runs community deep research and competitive research in parallel, generates content, then runs the shared refinement loop (up to 3 iterations) to meet quality gates.

#### Outside-In Pipeline
Sequential DAG: Extract Insights → Community Research → Pain-Grounded Draft → Competitive Research → Enrich with Competitive Intel → Layer Product Specifics → Refinement Loop → Store

Starts from pure practitioner pain. Generates a first draft grounded entirely in community evidence, then sequentially enriches it with competitive positioning and product specifics. Each step feeds the next — no "pick best" comparisons. Falls back to Standard if no community evidence is found.

#### Adversarial Pipeline
Sequential DAG: Extract Insights → Research (parallel) → Generate Draft → Attack Round 1 → Defend Round 1 → Attack Round 2 → Defend Round 2 → Refinement Loop → Store

Generates an initial draft, then puts it through two rounds of adversarial sparring. A hostile skeptical practitioner critic (Gemini Pro) attacks the content, then the defender rewrites to survive every objection. The defended version after 2 rounds IS the output — no comparison against the initial draft.

#### Multi-Perspective Pipeline
Sequential DAG: Extract Insights → Research (parallel) → Generate 3 Perspectives (parallel) → Synthesize → Refinement Loop → Store

Generates three parallel perspectives (Practitioner Empathy, Competitive Positioning, Thought Leadership), then synthesizes the strongest elements into a single cohesive draft. The synthesized version IS the output — individual perspectives are not scored or compared.

### Shared Refinement Loop

All pipelines call `refinementLoop()` after their core generation logic:

1. Score the current content against quality gates
2. If gates pass, return immediately
3. If slop score exceeds threshold, run deslop pass
4. Build a refinement prompt targeting the specific failing dimensions
5. Generate refined version
6. If refined version scores lower (plateau), stop and keep current
7. Otherwise, update content and repeat (up to 3 iterations)

This replaces the previous one-shot refine approach and the `pickBestResult()` pattern.

### Pipeline Step Events

Each pipeline emits step events via `emitPipelineStep()` for live UI streaming. Steps include: `extract-insights`, `research`, `generate`, `refine`, plus pipeline-specific steps like `pain-draft`, `attack-r1`, `defend-r1`, `synthesize`, etc. Events are stored in the `pipeline_steps` column of `generation_jobs`.

### Removed

- **Split Research Pipeline**: Removed — identical to Standard pipeline (both already run community research first, then competitive research sequentially).
- **`pickBestResult()` pattern**: Removed from all pipelines. Each pipeline now follows a sequential DAG where each step feeds the next.


---

## Stage 5: Scoring & Stress Testing

**Forked from**: o11y.tips quality pipeline

### Purpose

Score each generated messaging asset across 5 quality dimensions using AI persona critics. Apply quality gates from the voice profile to determine pass/fail. Assets that fail are flagged for regeneration or human intervention.

### Input

- `messaging_assets` with status `draft`
- `persona_critics` (configured critic personas)
- `voice_profiles` quality gate thresholds

### Process

1. **Critic Assignment**: Each asset is evaluated by all active persona critics. Each critic scores the asset across all 5 dimensions.

2. **Scoring Dimensions**:

   | Dimension | What It Measures | High Score Means | Low Score Means |
   |-----------|-----------------|------------------|-----------------|
   | **Slop** (inverted) | Presence of AI-typical clichés, filler, and generic language | Clean, specific language free of AI patterns | Full of "leverage", "unlock", "game-changer", "comprehensive solution" |
   | **Vendor-Speak** (inverted) | Degree of self-congratulatory vendor language | Practitioner-focused, problem-centric | "Our industry-leading platform delivers unmatched..." |
   | **Authenticity** | Whether it sounds like a real human wrote it for real humans | Genuine, conversational, credible | Corporate, stiff, overly polished |
   | **Specificity** | Use of concrete details vs. vague generalities | Specific metrics, scenarios, examples | "Improve efficiency", "reduce costs", "streamline operations" |
   | **Persona-Fit** | How well the messaging resonates with the target persona | Speaks directly to the persona's concerns, uses their language | Generic messaging that could target anyone |

3. **Scoring Process**: For each (asset, critic, dimension) combination:
   - The critic's scoring prompt is combined with the dimension-specific evaluation criteria
   - The asset content and its traceability context (source pain points, quotes) are included
   - Gemini Flash scores the dimension on a 0-100 scale with reasoning and suggestions
   - Score, reasoning, and suggestions are stored in `persona_scores`

4. **Slop Detection & Deslop** (Special Handling):
   - If the slop dimension scores below 60 for any critic, the asset is flagged for "deslop"
   - The deslop pass uses Gemini Pro (not Flash) for higher quality language revision
   - Gemini Pro receives the asset, the slop scoring feedback, and instructions to remove AI-typical language while preserving meaning and voice
   - The deslopped version is stored as an `asset_variants` row with `variant_type = 'deslop'`
   - The deslopped version is re-scored

5. **Overall Score Calculation**: The overall score for an asset is computed as a weighted average across all critics and dimensions:
   ```
   overall = sum(critic_weight * dimension_score) / sum(critic_weight) for all (critic, dimension) pairs
   ```

6. **Quality Gate Evaluation**: The voice profile's quality gates define minimum scores per dimension. An asset passes the quality gate only if its average score (across all critics) for each dimension meets or exceeds the threshold:
   ```
   passed = all(avg_score_per_dimension[d] >= voice_profile.quality_gates[d] for d in dimensions)
   ```

7. **Status Update**: Assets are updated to:
   - `scored` with `passed_quality_gate = 1` if they pass
   - `scored` with `passed_quality_gate = 0` if they fail (flagged in admin UI)

### Output

- `persona_scores` rows for every (asset, critic, dimension) combination
- `messaging_assets` updated with `overall_score` and `passed_quality_gate`
- `asset_variants` rows for any deslop rewrites
- Assets transitioned to `scored` status

### Models Used

- **Gemini Flash** for dimension scoring (fast, cost-effective for high-volume scoring)
- **Gemini Pro** for slop detection and deslop rewrites (higher quality language assessment)

### Quality Checks

- All 5 dimensions scored by all active critics (completeness check)
- Score values within valid range (0-100)
- Reasoning non-empty for every score
- Quality gate thresholds validated against voice profile configuration
- Deslop variant re-scored to confirm improvement

---

## Stage 6: Review & Approve

### Purpose

Human review of scored messaging assets through the admin UI. PMM team members review, edit, approve, or reject assets. This is the final gate before messaging is considered ready for use.

### Input

- `messaging_assets` with status `scored`
- Quality scores and pass/fail indicators
- Traceability chains
- Any deslop variants

### Process

1. **Review Queue**: The admin UI presents assets in a review queue, sortable by:
   - Overall quality score (highest first for quick wins)
   - Quality gate status (passed first, or failed first for triage)
   - Asset type
   - Messaging priority
   - Creation date

2. **Asset Review**: For each asset, the reviewer sees:
   - Full asset content with formatting
   - Overall score and per-dimension scores with visualizations
   - Critic reasoning and suggestions for each dimension
   - Quality gate pass/fail breakdown
   - Full traceability chain (source pain points with links, quotes, product docs, research)
   - Any variants (deslop, regenerations)
   - Side-by-side comparison with variants

3. **Review Actions**:
   - **Approve**: Asset status changes to `approved`. It becomes a published messaging asset ready for use. Reviewer can add notes.
   - **Edit & Rescore**: Reviewer edits the content. The edit is recorded in the traceability `edit_history`. The edited asset is sent back through Stage 5 for rescoring.
   - **Regenerate**: Reviewer requests regeneration with optional parameter changes (different voice profile, additional context, specific instructions). Creates a new generation job and asset variant.
   - **Reject**: Asset status changes to `rejected` with reviewer notes explaining why. Rejection reasons feed back into prompt improvement.
   - **Archive**: Asset status changes to `archived`. Used for assets that are no longer relevant.

4. **Bulk Actions**: The admin UI supports bulk approve/reject for efficiently processing large queues of high-scoring assets.

5. **Gap Identification**: During review, if a reviewer notices a missing messaging angle, they can manually create a `messaging_gaps` entry to flag it for future generation.

### Output

- `messaging_assets` transitioned to `approved`, `rejected`, or `archived`
- `asset_traceability.edit_history` updated for any edits
- `messaging_gaps` entries for identified gaps
- `asset_variants` for any regenerations

### Model Used

- None (human review stage)

### Quality Checks

- Reviewer notes required for rejections
- Edit history recorded for all modifications
- Approved assets must have complete traceability records
- Status transitions are validated (cannot approve directly from `draft`, must be `scored` first)

---

## Pipeline Summary

```
Stage 1: Discovery
  Model: Gemini Flash
  Input:  Community Sources + Messaging Priorities
  Output: Scored Pain Points with Quotes

Stage 2: Product Context
  Model: None (rule-based)
  Input:  Uploaded Documents
  Output: Parsed & Chunked Product Knowledge

Stage 3: Competitive Research
  Model: Gemini Deep Research
  Input:  Pain Points + Competitor Names
  Output: Structured Competitive Intelligence

Stage 4: Messaging Generation
  Model: Gemini Pro (default), Claude (opt-in)
  Input:  Pain Points + Product Context + Research + Voice Profile
  Output: Draft Messaging Assets with Traceability

Stage 5: Scoring & Stress Testing
  Model: Gemini Flash + Gemini Pro
  Input:  Draft Assets + Persona Critics + Quality Gates
  Output: Scored Assets with Pass/Fail Indicators

Stage 6: Review & Approve
  Model: None (human review)
  Input:  Scored Assets + Traceability + Scores
  Output: Approved Messaging Assets
```


## Standard vs Outside-In: Pipeline Philosophy

| Aspect | Standard Pipeline | Outside-In Pipeline |
|--------|------------------|---------------------|
| **Philosophy** | "Here is our story — validate it" | "What is the community saying — build from that" |
| **Step 0** | Deep PoV Extraction (Gemini Pro) | Extract Insights (Gemini Flash) |
| **Extraction** | Thesis, contrarian take, narrative arc, strongest claims | Capabilities, differentiators, pain points |
| **Community Research** | Validation — confirms/challenges our PoV | Discovery — drives the narrative |
| **Generation Prompt** | PoV-first: leads with thesis and narrative arc | Pain-first: leads with practitioner frustration |
| **System Prompt** | "Lead with your point of view" | "Lead with the pain" |
| **Content Voice** | Opinionated, defensible argument | Empathetic, practitioner-resonant |
| **Best For** | Product launches, thought leadership, narratives | Battlecards, talk tracks, community-validated content |

### Standard Pipeline Flow
1. **Deep PoV Extraction** (Gemini Pro) — Extract thesis, contrarian take, narrative arc, strongest claims with evidence
2. **Community Validation** — Validate PoV against practitioner reality via Deep Research
3. **Competitive Research** — Sharpen positioning informed by community
4. **Generate from YOUR Narrative** — PoV-first prompt, community validates, competitive sharpens
5. **Score & Refine** — Quality gates with up to 3 refinement iterations
6. **Store** — Persist with traceability
