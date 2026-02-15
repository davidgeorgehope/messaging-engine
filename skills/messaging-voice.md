# Messaging Voice Skill

## Purpose
This skill defines how to write product messaging that sounds like it was written by someone who understands the practitioner's world — not by a marketing team reading a feature brief.

## Core Principles

### 1. Practitioner-First Language
- Write like someone who does this work daily — not someone who writes about it
- Use the language practitioners actually use (forums, Slack, conference talks)
- Avoid language practitioners mock: "single pane of glass", "seamless integration", "enterprise-grade"
- Reference real scenarios: "When your Kubernetes cluster has 200 namespaces and you can't find the one pod that's OOMKilling"

### 2. Pain Before Product
- ALWAYS lead with the pain, never with the product
- The practitioner should read the first sentence and think "yes, that's exactly my problem"
- Product capabilities come after the pain is established and validated
- If you can't articulate the pain specifically, you don't understand it well enough to message about it

### 3. Specificity Over Claims
- BAD: "Our industry-leading platform provides comprehensive solutions"
- GOOD: "Correlate your traces with logs in one click — no context-switching between 4 different tools"
- BAD: "Industry-leading performance"
- GOOD: "P99 query latency under 200ms on 10TB of log data"
- Every claim should be verifiable or at least experiential

### 4. Quotes and Evidence
- Anchor messaging in real practitioner quotes when available
- "We heard this from a practitioner at a Fortune 500: 'I spend 30 minutes just figuring out which dashboard to look at'"
- Attribution adds credibility even when anonymized
- Quotes should feel raw, not polished — practitioners detect sanitized quotes instantly

### 5. Anti-Patterns (Never Do These)

#### Vendor Speak
- "We are excited to announce" → just announce it
- "Industry-leading" → leading how? prove it
- "Enterprise-grade" → what does this actually mean for me?
- "Seamless" → nothing is seamless, be honest about the experience
- "Single pane of glass" → practitioners actively mock this phrase
- "Digital transformation" → banned, full stop
- "Best-in-class" → compared to what? says who?

#### Empty Superlatives
- "The most powerful" → powerful at what specifically?
- "Unmatched" → by whom? in what dimension?
- "Revolutionary" → does it actually change how people work?

#### Feature Dumping
- Don't list features without connecting them to pain
- Every feature mention should answer "so what?" for the practitioner
- "We support OpenTelemetry" → "Your existing OTel instrumentation works out of the box — no proprietary agents"

### 6. Voice Calibration by Context

#### Practitioner Community Voice (strictest)
- Sounds like: a senior engineer writing a thoughtful Reddit comment
- Tone: direct, experienced, slightly skeptical, helpful
- Avoids: all marketing language, superlatives, exclamation marks
- Thresholds: vendorSpeakMax=3, authenticityMin=8

#### Sales Enablement Voice (moderate)
- Sounds like: a solutions architect who used to be a practitioner
- Tone: confident but credible, specific about capabilities
- Allows: some product positioning, competitive framing
- Thresholds: vendorSpeakMax=6, authenticityMin=6

#### Product Launch Voice (permissive)
- Sounds like: a product manager who builds the product AND uses it
- Tone: enthusiastic but grounded, specific about what's new
- Allows: more marketing language, celebration of achievements
- Thresholds: vendorSpeakMax=7, authenticityMin=5

#### Field Marketing Voice (balanced)
- Sounds like: a technical marketer who attends practitioner conferences
- Tone: approachable, knowledgeable, empathetic
- Allows: moderate vendor language, broader value props
- Thresholds: vendorSpeakMax=5, authenticityMin=7

## Application
When generating messaging:
1. Load the active voice profile(s)
2. Read the voice guide from the profile
3. Apply the voice principles above as the foundation
4. Layer the specific voice guide on top
5. Generate content that would pass the "practitioner eye-roll test"

## The Eye-Roll Test
After generating messaging, ask: "Would a senior practitioner reading this eye-roll?" If yes, rewrite. Real practitioners have extremely sensitive BS detectors honed by years of vendor pitches. The best messaging makes them nod, not cringe.
