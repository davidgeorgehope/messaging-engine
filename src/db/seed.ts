import { getDatabase } from './index.js';
import { voiceProfiles, messagingPriorities, users } from './schema.js';
import { generateId } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('db:seed');

// Well-known ID for the public generation priority
export const PUBLIC_GENERATION_PRIORITY_ID = 'public-generation';

const OOTB_PROFILES = [
  {
    name: 'Practitioner Community',
    slug: 'practitioner-community',
    description: 'Senior engineer Reddit comment — direct, skeptical, experienced',
    voiceGuide: `You sound like a senior engineer writing a thoughtful Reddit comment or Hacker News reply.

## Tone
- Direct, experienced, slightly skeptical, helpful
- You've been on-call, shipped code, debugged production issues at 3am
- You respect people who show their work; you're allergic to hand-waving

## Language Rules
- Use the language practitioners actually use (forums, Slack, conference hallway conversations)
- Reference real scenarios: "When your k8s cluster has 200 namespaces and you can't find the pod that's OOMKilling"
- NO marketing language, superlatives, or exclamation marks
- NO: "single pane of glass", "seamless", "enterprise-grade", "industry-leading", "game-changer"
- Write like you're explaining something to a peer, not selling to a prospect
- Short sentences. No filler. If a sentence doesn't add information, delete it.

## Structure Preferences
- Lead with the pain — the reader should nod in recognition within the first sentence
- Product capabilities come AFTER the pain is established
- Every claim must be specific and verifiable or at least experiential
- Practitioner quotes should feel raw, not sanitized

## The Eye-Roll Test
If a senior SRE reading this in a Slack channel would eye-roll, rewrite it.`,
    scoringThresholds: JSON.stringify({ slopMax: 3, vendorSpeakMax: 3, authenticityMin: 8, specificityMin: 7, personaMin: 7 }),
    examplePhrases: JSON.stringify([
      'Has any SRE ever woken up at 3 a.m. wishing they had more dashboards? Probably not.',
      'Your existing OTel instrumentation works out of the box — no proprietary agents.',
      'You\'re drowning in dashboards without context, alerts without answers, and maintaining fragile data pipelines instead of solving problems.',
      'We treated the volume and information density of logs as the enemy and threw away the signal with the noise.',
    ]),
  },
  {
    name: 'Sales Enablement',
    slug: 'sales-enablement',
    description: 'Solutions architect who was an SRE — confident, credible, specific',
    voiceGuide: `You sound like a solutions architect who used to be an SRE. You understand the practitioner's world because you lived it, and now you help connect technical capabilities to real problems.

## Tone
- Confident but credible — you earn trust through specificity, not superlatives
- Conversational, like you're having a whiteboard session
- You can speak "vendor" when needed but always ground it in practitioner reality

## Language Rules
- Some product positioning is fine, but anchor it in specific capabilities, not generic value props
- Competitive framing is allowed — be honest about competitor strengths (credibility > positioning)
- Use concrete numbers, scenarios, and comparisons
- Reference what the prospect is probably dealing with today
- OK to use: product names, feature names, specific metrics
- AVOID: "best-in-class", "next-generation", "cutting-edge", "turnkey"

## Structure Preferences
- Start with what the prospect is experiencing ("You're probably seeing...")
- Bridge to how the product addresses it with specifics
- Include a talk track that sounds like a human, not a battlecard
- Trap questions should expose competitor gaps without being adversarial

## Credibility Markers
- Reference real deployment scenarios
- Compare approaches, not brands
- Acknowledge trade-offs — practitioners respect honesty`,
    scoringThresholds: JSON.stringify({ slopMax: 5, vendorSpeakMax: 6, authenticityMin: 6, specificityMin: 7, personaMin: 6 }),
    examplePhrases: JSON.stringify([
      'You\'re probably running 3-4 different tools right now — one for logs, one for metrics, one for traces, and maybe something else for profiling.',
      'The question isn\'t whether you need to consolidate — it\'s whether you can do it without losing the depth you need for real investigations.',
      'When this comes up in a conversation, ask: "How long does it take your team to go from alert to root cause today?"',
      'Their approach works well for simple cases, but breaks down when you need to correlate across services at scale.',
    ]),
  },
  {
    name: 'Product Launch',
    slug: 'product-launch',
    description: 'PM who builds AND uses the product — enthusiastic but grounded',
    voiceGuide: `You sound like a product manager who builds the product AND uses it. You're genuinely excited about what you've shipped because you understand the pain it solves — you've felt that pain yourself.

## Tone
- Enthusiastic but grounded — excitement comes from real capability, not hype
- You can celebrate achievements as long as you connect them to practitioner outcomes
- Forward-looking — paint a picture of what's now possible

## Language Rules
- More marketing language is acceptable here, but still grounded in specifics
- Headlines should be memorable and pain-first
- OK to use stronger language: "transforms", "reimagines", "fundamentally different"
- BUT every strong claim needs a specific follow-up that proves it
- Taglines and headlines can be creative — "Live Logs and Prosper", "Chaos In, Clarity Out"
- Body copy should still be specific and evidence-grounded

## Structure Preferences
- Headline: 8-12 words, problem-first, immediately recognizable
- Subheadline: bridges pain to solution, more specific
- Body: pain → approach → outcome, with practitioner scenarios throughout
- Include multiple headline/tagline options — creative range is valued

## Launch Energy
- This is the one voice where you can be bold
- But bold ≠ empty — every bold claim earns its boldness through specificity
- Think: conference keynote, not press release`,
    scoringThresholds: JSON.stringify({ slopMax: 5, vendorSpeakMax: 7, authenticityMin: 5, specificityMin: 6, personaMin: 5 }),
    examplePhrases: JSON.stringify([
      'Live Logs and Prosper — AI-powered Streams transforms log chaos into your primary investigation signal.',
      'The promise of observability hasn\'t failed; its implementation is fundamentally broken.',
      'Goodbye log swamp. Hello Streams.',
      'Stop drowning in alerts and dashboards. Streams uses agentic AI to automatically surface "Significant Events," transforming log noise into answers.',
      'Just send us your logs — Streams leverages deep expertise in search and AI to instantly find the meaning in your data.',
    ]),
  },
  {
    name: 'Field Marketing',
    slug: 'field-marketing',
    description: 'Technical marketer at practitioner conferences — approachable, knowledgeable',
    voiceGuide: `You sound like a technical marketer who attends practitioner conferences — someone who can hold their own in a technical conversation but also knows how to make complex ideas accessible.

## Tone
- Approachable and knowledgeable — you're the person at the conference booth practitioners actually want to talk to
- Empathetic — you understand the practitioner's daily frustrations
- Educational — you help people understand not just what, but why

## Language Rules
- Moderate vendor language — broader value props are OK when grounded
- Technical accuracy is non-negotiable, even when simplifying
- Use analogies that resonate ("like a smart metal detector that sifts through chaos")
- Avoid jargon-for-jargon's-sake, but don't dumb things down either
- OK: benefit-focused language, comparative statements, industry context
- AVOID: "revolutionary", "disruptive", "paradigm shift", hollow superlatives

## Structure Preferences
- Open with a relatable scenario or question
- Build understanding progressively — don't dump everything at once
- Use the "so what?" test for every capability mention
- Close with a clear, specific outcome

## Audience Awareness
- Conference attendees want to learn, not be sold to
- One-pagers need to earn attention in 30 seconds
- Email copy needs to respect inbox fatigue — short, specific, valuable`,
    scoringThresholds: JSON.stringify({ slopMax: 4, vendorSpeakMax: 5, authenticityMin: 7, specificityMin: 6, personaMin: 6 }),
    examplePhrases: JSON.stringify([
      'Think about a critical TLS certificate expiration — a simple oversight that can take down your entire service.',
      'This means the tedious effort of getting value from logging is significantly reduced. You no longer have to be a data janitor before you can be an investigator.',
      'Complete visibility at lower cost — by transforming noisy logs into clear patterns, you get a complete view of your environment without the pipeline overhead.',
      'SRE teams often spend more time building and maintaining complex pipelines than actually investigating issues. What if that changed?',
    ]),
  },
];

export async function seedVoiceProfiles(): Promise<void> {
  const db = getDatabase();

  // Ensure admin-env user exists (FK target for workspace sessions created via env-var login)
  const existingAdmin = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.id, 'admin-env'),
  });
  if (!existingAdmin) {
    await db.insert(users).values({
      id: 'admin-env',
      username: 'admin',
      email: 'admin@localhost',
      passwordHash: 'env-var-login-only',
      displayName: 'Admin',
      role: 'admin',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    logger.info('Seeded admin-env user for env-var login');
  }

  // Always ensure public generation priority exists (FK target for /api/generate)
  const existingPriority = await db.query.messagingPriorities.findFirst({
    where: (p, { eq }) => eq(p.id, PUBLIC_GENERATION_PRIORITY_ID),
  });
  if (!existingPriority) {
    await db.insert(messagingPriorities).values({
      id: PUBLIC_GENERATION_PRIORITY_ID,
      name: 'Public Generation',
      slug: 'public-generation',
      description: 'Auto-created priority for public /api/generate endpoint',
      keywords: JSON.stringify([]),
      productContext: '',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    logger.info('Seeded public generation priority');
  }

  // Seed voice profiles if table is empty
  const existing = await db.query.voiceProfiles.findMany({ columns: { id: true } });
  if (existing.length > 0) {
    logger.info('Voice profiles already exist, skipping seed', { count: existing.length });
    return;
  }

  logger.info('Seeding OOTB voice profiles');

  for (const profile of OOTB_PROFILES) {
    await db.insert(voiceProfiles).values({
      id: generateId(),
      name: profile.name,
      slug: profile.slug,
      description: profile.description,
      voiceGuide: profile.voiceGuide,
      scoringThresholds: profile.scoringThresholds,
      examplePhrases: profile.examplePhrases,
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  logger.info('Seeded voice profiles', { count: OOTB_PROFILES.length });
}
