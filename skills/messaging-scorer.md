# Messaging Scorer Skill

## Purpose
This skill defines how to evaluate messaging quality across 5 dimensions, ensuring generated content meets practitioner standards.

## Scoring Dimensions

### 1. Slop Score (0-10, lower is better)
Detects AI writing patterns that make content feel generic and machine-generated.

**What triggers high slop scores:**
- Hedging: "It's worth noting", "It's important to remember", "In general"
- Filler transitions: "Let's dive in", "Let's explore", "Moving on", "With that said"
- Article meta-references: "In this article", "As we'll see", "In today's landscape"
- Overused AI words: "robust", "leverage", "utilize", "seamless", "cutting-edge"
- Enthusiasm inflation: "exciting", "amazing", "incredible", "game-changer"
- Clichés: "at the end of the day", "tip of the iceberg", "in a nutshell"

**Scoring method:** Hybrid rule-based pattern detection + Gemini Flash AI analysis.
- Pattern detection finds specific phrases
- AI analysis catches subtler patterns (repetitive structure, passive voice overuse)
- Final score = average of both

**Threshold:** Typically max 4-5 depending on voice profile.

### 2. Vendor-Speak Score (0-10, lower is better)
Detects marketing jargon, empty claims, and press-release tone.

**What triggers high vendor-speak scores:**
- Buzzwords: "industry-leading", "best-in-class", "next-generation", "enterprise-grade"
- Empty superlatives: "unparalleled", "unmatched", "the only solution"
- Feature dumping: listing capabilities without connecting to pain
- Press release tone: "We are excited to announce", "empowering teams"
- Vacuous claims: statements that sound impressive but say nothing concrete

**Scoring method:** Pattern detection + AI analysis that asks "does this sound like a press release or like a practitioner?"

**Threshold:** Varies dramatically by voice — 3 for practitioner community, 7 for product launch.

### 3. Practitioner Authenticity Score (0-10, higher is better)
Measures how grounded the messaging is in real practitioner experience.

**What drives high authenticity scores:**
- Uses actual practitioner language from discovered pain points
- References specific scenarios practitioners encounter
- Sounds like someone who has lived the problem, not read about it
- Uses the exact quotes and phrases from community sources
- Acknowledges real tradeoffs and limitations honestly

**What drives low authenticity scores:**
- Generic descriptions that could apply to any product
- Scenarios that feel invented rather than observed
- Language that sounds like a feature brief, not a practitioner conversation
- Ignoring the messy reality of how practitioners actually work

**Scoring method:** AI analysis comparing messaging against source pain point quotes and practitioner language patterns.

### 4. Specificity Score (0-10, higher is better)
Measures how concrete and verifiable the messaging claims are.

**What drives high specificity scores:**
- Named product capabilities (not just "our platform")
- Numbers and metrics ("P99 under 200ms", "reduces MTTR by 40%")
- Specific use cases ("when your Kubernetes cluster has 200 namespaces")
- Verifiable claims backed by product documentation
- Concrete before/after scenarios

**What drives low specificity scores:**
- Vague value props ("saves time", "increases efficiency")
- Claims that work for any product ("easy to use", "powerful")
- No connection to specific capabilities
- Could swap in any competitor's name and it still reads the same

**Scoring method:** AI analysis counting concrete claims vs vague claims, cross-referencing with product documentation when available.

### 5. Persona Stress Test (0-10 per persona, averaged)
Runs messaging through AI critic personas representing the target audience.

**Default personas:**
1. **Skeptical Senior SRE** — 12 years experience, been burned by vendors, values honesty and specificity
2. **Cost-Conscious Platform Engineer** — tight budget, evaluates ROI ruthlessly, tired of tools that overpromise
3. **App Developer Who Hates O11y Tooling** — views observability as necessary evil, values simplicity above all

**Each persona evaluates:**
- Would this make me want to learn more?
- Does this understand my actual reality?
- Is this honest or is it selling me something?
- What works? What doesn't?

**Scoring method:** Each persona provides a 0-10 score + qualitative feedback. Final score is the average.

## Quality Gates

Quality gates are defined **per voice profile** via the `scoringThresholds` JSON field:

| Dimension | Check | Example Thresholds |
|-----------|-------|-------------------|
| Slop | score ≤ slopMax | 4 (practitioner) / 5 (sales) |
| Vendor-Speak | score ≤ vendorSpeakMax | 3 (practitioner) / 7 (launch) |
| Authenticity | score ≥ authenticityMin | 8 (practitioner) / 5 (launch) |
| Specificity | score ≥ specificityMin | 7 (practitioner) / 6 (launch) |
| Persona Avg | score ≥ personaMin | 7 (practitioner) / 5 (launch) |

- ALL gates must pass for a variant to reach "review" status
- ANY failure → "rejected" status (can retry or manually override)

## Interpretation Guide
- Scores 8-10: Exceptional — rare, indicates truly authentic practitioner-quality messaging
- Scores 6-7: Good — solid messaging that should pass most voice profiles
- Scores 4-5: Mediocre — needs improvement, may pass permissive profiles only
- Scores 0-3: Poor — significant rewrite needed, too much vendor-speak or too generic
