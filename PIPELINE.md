# PIPELINE.md — Generation Pipeline Reference

## Overview

The messaging engine has **5 generation pipelines**, each with different strategies for producing messaging assets. All pipelines share common primitives from `src/services/pipeline/orchestrator.ts` and produce the same output format: scored messaging assets stored with full traceability.

## Pipeline Selection

Pipelines are selected per session via the `pipeline` field. Default: `'outside-in'`.

| Pipeline | Slug | Best For | Key Characteristic |
|----------|------|----------|-------------------|
| Standard | `standard` | General messaging from product docs | Deep PoV extraction → research → generation |
| Outside-In | `outside-in` | Practitioner-authentic messaging | Community-first; **fails if no evidence** |
| Adversarial | `adversarial` | Battle-tested messaging | 2 rounds of hostile critique + defense |
| Multi-Perspective | `multi-perspective` | Well-rounded messaging | 3 angles synthesized into best version |
| Straight-Through | `straight-through` | Scoring existing content | No generation — score only |

## Shared Pipeline Infrastructure

### Orchestrator (`orchestrator.ts`)

All pipelines compose from these shared functions:

```
loadJobInputs(jobId) → JobInputs
    ↓
extractInsights(productDocs) → insights
    ↓
nameSessionFromInsights(jobId, insights, assetTypes)  [async, best-effort]
    ↓
For each assetType × voice:
    buildSystemPrompt(voice, assetType, evidenceLevel, ...) → system prompt
    buildUserPrompt(messaging, prompt, research, template, ...) → user prompt
    generateContent(prompt, options, model) → AI response
    refinementLoop(content, context, thresholds, voice, ...) → refined content + scores
    storeVariant(jobId, assetType, voice, content, scores, ...) → DB records
    ↓
finalizeJob(jobId, researchAvailable, researchLength)
```

### Evidence Bundle (`evidence.ts`)

Community and competitive research shared across pipelines:

- **`runCommunityDeepResearch(insights, prompt)`** — Gemini Deep Research for practitioner quotes and pain points from Reddit, HN, Stack Overflow, GitHub Issues, dev blogs
- **`runCompetitiveResearch(insights, prompt)`** — Deep Research for competitor analysis

**Evidence Levels**:
| Level | Criteria |
|-------|---------|
| `strong` | ≥3 source URLs from ≥2 unique host types |
| `partial` | ≥1 source URL or grounded search text >100 chars |
| `product-only` | No external evidence found |

**Retry strategy**:
- Grounded search: 5x retries on empty results (3s × attempt delay)
- Community deep research: 3x full retries if evidence level is `product-only`

### Prompt System (`prompts.ts`)

**8 Asset Types** with per-type generation temperatures:

| Asset Type | Temperature | Description |
|------------|-------------|-------------|
| `messaging_template` | 0.5 | Comprehensive positioning document (3000–5000 words) |
| `battlecard` | 0.55 | Competitive battlecard |
| `one_pager` | 0.6 | One-page summary |
| `talk_track` | 0.65 | Sales talk track |
| `launch_messaging` | 0.7 | Product launch messaging |
| `email_copy` | 0.75 | Email campaign copy |
| `narrative` | 0.8 | 3-variant storytelling narrative |
| `social_hook` | 0.85 | Social media hooks |

**4 Persona Angles** (used in prompt construction):
- `practitioner-community` — Daily frustrations, peer language
- `sales-enablement` — Whiteboard conversations, objection handling
- `product-launch` — Bold headlines, before/after contrast
- `field-marketing` — 30-second attention, scannable format

**Banned Words System**:
- `DEFAULT_BANNED_WORDS`: 13 static banned phrases (industry-leading, best-in-class, etc.)
- `generateBannedWords(voice, insights)`: LLM-generated per-voice banned words
  - Retries 3x with exponential backoff (2s × attempt)
  - Falls back to defaults if all retries fail
- Cached per `voiceId:domain` (in-memory, cleared on restart)

### Quality Scoring

All pipelines use `scoreContent()` from `src/services/quality/score-content.ts`:

**5 parallel scorers** (0–10 scale):
1. **Slop** — Pattern-based + AI analysis (lower is better)
2. **Vendor-Speak** — Vendor language detection (lower is better)
3. **Authenticity** — Human-likeness scoring (higher is better)
4. **Specificity** — Concrete detail scoring (higher is better)
5. **Persona-Fit** — Target audience resonance (higher is better)

**Quality gates**: Per-voice-profile thresholds. Defaults: `slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6`

**Refinement Loop** (`refinementLoop()`):
1. Score content
2. If ≥2 scorers failed → skip refinement, mark for manual review
3. For up to N iterations (default 3):
   - If slop exceeds threshold → deslop
   - Build refinement prompt from failing scores
   - Generate refined version
   - Score new version
   - If `totalQualityScore` didn't improve → stop (plateau)
4. Return best content + scores

### Storage

`storeVariant()` creates 3 records per generation:
1. **`messaging_assets`** — Primary asset with scores and evidence level
2. **`asset_variants`** — Per-voice variant with full quality scores
3. **`asset_traceability`** — Evidence chain: practitioner quotes + generation prompts

Grounding validation runs before storage: `validateGrounding()` detects and strips fabricated claims.

---

## Pipeline 1: Standard

**Slug**: `standard`  
**File**: `src/services/pipeline/pipelines/standard.ts`

The Standard pipeline uses deep PoV extraction and combines community + competitive research.

### Steps

1. **Deep PoV Extraction** (Gemini Pro)
   - `extractDeepPoV(productDocs)` — comprehensive point-of-view analysis
   - Falls back to `extractInsights()` if PoV extraction fails
   - Names session from insights

2. **Banned Words** — Pre-generated per voice in parallel

3. **Community Deep Research** (Deep Research agent)
   - 3x retries if no evidence
   - Builds practitioner context

4. **Competitive Research** (Deep Research agent)
   - Includes community findings to inform analysis

5. **Per Asset Type × Voice**:
   - **PoV-first generation** — `buildPoVFirstPrompt()` with deep PoV context
   - **Score** — Immediate quality scoring
   - **Product doc layering** — Enrich with product documentation
   - **Refinement loop** — Up to 3 iterations
   - **Store variant**

6. **Finalize job**

---

## Pipeline 2: Outside-In

**Slug**: `outside-in`  
**File**: `src/services/pipeline/pipelines/outside-in.ts`

The Outside-In pipeline prioritizes practitioner authenticity. It starts with community evidence and **fails hard** if no real evidence is found.

### Key Differences
- **No fallback** — throws error if all community research retries exhausted
- **No product doc layering** — keeps practitioner voice pure
- Pain-grounded draft → competitive enrichment → refinement

### Steps

1. **Extract Insights** (Gemini Flash) + name session

2. **Banned Words** — Pre-generated per voice

3. **Community Deep Research** (Deep Research agent)
   - 3x full retries if evidence level is `product-only`
   - **Throws error** if still no evidence after retries

4. **Per Asset Type × Voice**:
   - **Pain-grounded draft** — `buildPainFirstPrompt()` with practitioner context
   - **Competitive research** (per voice) — Deep Research
   - **Competitive enrichment** — Weave competitive positioning without losing practitioner voice
   - **Refinement loop** — Up to 3 iterations
   - **Store variant**

5. **Finalize job**

---

## Pipeline 3: Adversarial

**Slug**: `adversarial`  
**File**: `src/services/pipeline/pipelines/adversarial.ts`

The Adversarial pipeline puts every draft through hostile critique to produce battle-hardened messaging.

### Steps

1. **Extract Insights** (Gemini Flash) + name session

2. **Banned Words** — Pre-generated per voice

3. **Community Deep Research** (Deep Research agent)

4. **Competitive Research** (Deep Research agent)
   - Enriched with community findings

5. **Per Asset Type × Voice**:
   - **Generate initial draft** — Standard generation with research context
   - **Attack Round 1** (Gemini Pro) — Hostile senior practitioner tears apart the messaging:
     - Unsubstantiated claims
     - Vendor-speak detection
     - Vague promises
     - Reality check
     - Missing objections
     - Credibility gaps
   - **Defend Round 1** (selected model) — Rewrite to survive every objection with product intelligence
   - **Attack Round 2** — Second round of critique
   - **Defend Round 2** — Second rewrite
   - **Refinement loop** — Up to 3 iterations
   - **Store variant**

6. **Finalize job**

---

## Pipeline 4: Multi-Perspective

**Slug**: `multi-perspective`  
**File**: `src/services/pipeline/pipelines/multi-perspective.ts`

The Multi-Perspective pipeline generates from 3 angles and synthesizes the best elements.

### Steps

1. **Extract Insights** (Gemini Flash) + name session

2. **Banned Words** — Pre-generated per voice

3. **Community Deep Research** (Deep Research agent)

4. **Competitive Research** (Deep Research agent)

5. **Per Asset Type × Voice**:
   - **Generate initial draft** — Standard generation
   - **3 parallel perspective rewrites**:
     - **Empathy** — Lead with pain, practitioner language, product as afterthought
     - **Competitive** — Lead with what alternatives fail at, specific workflow differences
     - **Thought Leadership** — Lead with industry's broken promise, systemic framing
   - **Synthesize** — Take strongest elements from all 3 into one cohesive piece
   - **Score all 4** (3 perspectives + synthesis) — Keep highest `totalQualityScore`
   - **Refinement loop** — Up to 3 iterations
   - **Store variant**

6. **Finalize job**

---

## Pipeline 5: Straight-Through

**Slug**: `straight-through`  
**File**: `src/services/pipeline/pipelines/straight-through.ts`

The Straight-Through pipeline scores existing content without generating new content.

### Prerequisites
- Requires `existingMessaging` content in session metadata
- Fails immediately if no existing messaging provided

### Steps

1. **Extract Insights** (Gemini Flash) + name session

2. **Per Asset Type × Voice**:
   - **Score existing content** — Full 5-dimension scoring
   - **Store scored result** — as variant with scores

3. **Finalize job** (no research)

---

## Workspace Actions

Workspace actions are post-generation operations that create new versions within a session. They use the same underlying primitives but are triggered individually rather than as part of a pipeline run.

| Action | Function | Description |
|--------|----------|-------------|
| Deslop | `runDeslopAction` | Analyze slop → deslop → score → new version |
| Regenerate | `runRegenerateAction` | Full regeneration with voice + template + refinement |
| Voice Change | `runVoiceChangeAction` | Rewrite in different voice profile |
| Adversarial Loop | `runAdversarialLoopAction` | 1–3 iterations; fix mode (below thresholds) or elevation mode (above thresholds) |
| Competitive Deep Dive | `runCompetitiveDeepDiveAction` | Deep Research → competitive enrichment |
| Community Check | `runCommunityCheckAction` | Deep Research → practitioner language rewrite |
| Multi-Perspective | `runMultiPerspectiveAction` | 3 angles → synthesize → score all 4, keep best |

All actions are executed via `runActionInBackground()` which creates an `action_jobs` record for progress tracking.

## Model Usage by Pipeline Step

| Step | Model Task | Production Model |
|------|-----------|-----------------|
| Insight extraction | `flash` | gemini-3-flash-preview |
| Deep PoV extraction | `pro` | gemini-3-pro-preview |
| Session naming | `flash` | gemini-3-flash-preview |
| Banned words generation | `flash` | gemini-3-flash-preview |
| Community research | `deepResearch` | deep-research-pro-preview |
| Competitive research | `deepResearch` | deep-research-pro-preview |
| Grounded search | `flash` | gemini-3-flash-preview |
| Content generation | `pro` (or selected model) | gemini-3-pro-preview |
| Attack prompts | `pro` | gemini-3-pro-preview |
| Refinement | selected model | gemini-3-pro-preview |
| Scoring | all 5 scorers | gemini-3-flash-preview |
| Deslop | `deslop` | gemini-3-pro-preview |
| JSON generation | `pro` | gemini-3-pro-preview |
