# Pipelines

The messaging engine supports 5 distinct generation pipelines. Each follows a sequential DAG pattern — every step feeds the next, no branching or "pick best" comparisons.

All pipelines (except Straight Through) share the refinement loop: score → deslop → refine → check plateau (up to 3 iterations).

## Pipeline Selection

```
POST /api/generate
{ "pipeline": "standard" | "outside-in" | "adversarial" | "multi-perspective" | "straight-through" }
```

Default: `standard`

---

## 1. Standard Pipeline

**Philosophy:** PoV-first — extract a deep product thesis before generating.

```
Deep PoV Extraction (Pro)
  → Insight Extraction (Flash)
  → Community Research (Deep Research)
  → Competitive Research (Deep Research)
  → For each assetType × voice:
      → Generate with PoV-first prompt (Pro)
      → Score (5 scorers in parallel)
      → Refinement Loop (up to 3x)
      → Store variant
```

**Key feature:** Uses `extractDeepPoV()` to build a product thesis, narrative arc, and defensible claims before any content generation begins.

---

## 2. Outside-In Pipeline (Signature)

**Philosophy:** Community pain-first — start with real practitioner frustrations, not product features.

```
Insight Extraction (Flash)
  → Community Deep Research (Deep Research)
      — mines Reddit, HN, SO, GitHub for real pain
  → Competitive Research (Deep Research)
  → For each assetType × voice:
      → Generate with pain-first prompt (Pro)
          — leads with empathy, introduces product as relief
      → Score (5 scorers in parallel)
      → Refinement Loop (up to 3x)
      → Store variant
```

**Key feature:** Community research drives the narrative. The `buildPainFirstPrompt()` ensures content opens with practitioner frustration before any product mention.

---

## 3. Adversarial Pipeline

**Philosophy:** Attack/defend — generate critical objections, then craft messaging that survives them.

```
Insight Extraction (Flash)
  → Community Research (Deep Research)
  → Competitive Research (Deep Research)
  → For each assetType × voice:
      → Generate attack content (Pro) — hostile buyer objections
      → Generate defense content (Pro) — messaging that addresses attacks
      → Score defense (5 scorers in parallel)
      → Refinement Loop (up to 3x)
      → Store variant
```

**Key feature:** Two-phase generation produces messaging that's pre-tested against real objections. The attack phase uses a skeptical buyer persona.

---

## 4. Multi-Perspective Pipeline

**Philosophy:** 3 angles + synthesis — generate from practitioner, buyer, and executive perspectives, then merge.

```
Insight Extraction (Flash)
  → Community Research (Deep Research)
  → Competitive Research (Deep Research)
  → For each assetType × voice:
      → Generate Practitioner angle (Pro)
      → Generate Buyer angle (Pro)
      → Generate Executive angle (Pro)
      → Synthesize all 3 into unified content (Pro)
      → Score synthesis (5 scorers in parallel)
      → Refinement Loop (up to 3x)
      → Store variant
```

**Key feature:** Uses `PERSONA_ANGLES` to generate 3 distinct perspectives before synthesizing. The synthesis prompt ensures all angles are represented in the final output.

---

## 5. Straight Through Pipeline

**Philosophy:** Score-only — evaluate existing content without any generation or transformation.

```
Insight Extraction (Flash)
  → For each assetType × voice:
      → Score existing content (5 scorers in parallel)
      → Store variant (original content preserved as-is)
```

**Key differences from other pipelines:**
- **NO generation** — user's content is never rewritten
- **NO refinement loop** — no deslop, no iteration
- **NO research phase** — no community or competitive research
- **Requires `existingMessaging`** — fails immediately if not provided

**Use case:** Benchmarking existing marketing content against the quality scoring system. Useful for "how good is what we already have?" assessments.

---

## Shared Components

### Refinement Loop (`refinementLoop()`)

Used by Standard, Outside-In, Adversarial, and Multi-Perspective:

1. Score content with all 5 scorers
2. If quality gates pass → done
3. Run deslop to remove AI clichés
4. Build refinement prompt with specific score feedback
5. Regenerate with refinement context
6. Rescore — if scores plateau (no improvement), stop early
7. Repeat up to 3 times

### Model Usage Pattern

| Phase | Model (Production) | Rationale |
|-------|-------------------|-----------|
| Insight extraction | Flash | Fast, cheap, good at structured extraction |
| Deep PoV extraction | Pro | Needs reasoning depth for thesis building |
| Research | Deep Research | Purpose-built for web research |
| Generation | Pro | Quality matters most here |
| Scoring | Flash | Fast parallel evaluation |
| Deslop | Pro | Needs nuance to remove clichés without losing meaning |
| Refinement | Pro | Iterative improvement needs strong reasoning |

### Evidence Bundle

Community and competitive research results are packaged as an `EvidenceBundle`:
- `communityPain` — real quotes and frustrations from developer communities
- `competitorWeaknesses` — gaps in competitor positioning
- `practitionerQuotes` — attributed community quotes with source URLs
- `evidenceLevel` — classified as `strong`, `moderate`, or `weak`
