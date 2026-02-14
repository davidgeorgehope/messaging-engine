// Persona stress testing
// Runs messaging through AI critic personas that represent target audience segments
// Each persona scores 0-10 and provides blunt feedback

import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';
import { getDatabase } from '../../db/index.js';
import { personaCritics } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const logger = createLogger('quality:persona-critic');

export interface PersonaCriticResult {
  personaId: string;
  personaName: string;
  score: number;  // 0-10
  feedback: string;
  strengths: string[];
  weaknesses: string[];
}

// Default persona prompts if none configured in DB
const DEFAULT_PERSONAS = [
  {
    name: 'Skeptical Senior SRE',
    prompt: `You are a senior SRE with 12 years of experience. You've been on-call more nights than you can count. You're deeply skeptical of vendor claims because you've been burned before. You value: specificity, honesty about limitations, understanding of real operational pain, and respect for your time. You hate: buzzwords, hand-wavy claims, anything that sounds like it was written by someone who's never been paged at 3am. Score this messaging 0-10 and be brutally honest.`,
  },
  {
    name: 'Cost-Conscious Platform Engineer',
    prompt: `You are a platform engineering lead at a mid-size company. Your budget is tight and getting tighter. You evaluate everything through the lens of: does this actually save money or time? Is this a real need or a nice-to-have? You're tired of tools that promise the world and deliver marginal improvements. Score this messaging 0-10 based on whether it would make you want to learn more, and be specific about what works and what doesn't.`,
  },
  {
    name: 'App Developer Who Hates O11y Tooling',
    prompt: `You are a full-stack developer who views observability as a necessary evil. You just want to ship features and not spend hours configuring dashboards. You're suspicious of any tool that requires "just a few minutes of setup" (it never is). You value: simplicity, developer experience, not having to learn yet another query language. Score this messaging 0-10 on whether it speaks to your reality, not some idealized DevOps world you don't live in.`,
  },
];

export async function runPersonaCritics(content: string): Promise<PersonaCriticResult[]> {
  const db = getDatabase();

  // Load personas from DB, fall back to defaults
  const dbPersonas = await db.query.personaCritics.findMany({
    where: eq(personaCritics.isActive, true),
  });

  const personas = dbPersonas.length > 0
    ? dbPersonas.map(p => ({ id: p.id, name: p.name, prompt: p.promptTemplate }))
    : DEFAULT_PERSONAS.map((p, i) => ({ id: `default-${i}`, name: p.name, prompt: p.prompt }));

  const results: PersonaCriticResult[] = [];

  for (const persona of personas) {
    try {
      const result = await runSingleCritic(content, persona);
      results.push(result);
    } catch (error) {
      logger.error('Persona critic failed', { persona: persona.name, error });
      results.push({
        personaId: persona.id,
        personaName: persona.name,
        score: 5,
        feedback: 'Critic analysis failed',
        strengths: [],
        weaknesses: [],
      });
    }
  }

  return results;
}

async function runSingleCritic(
  content: string,
  persona: { id: string; name: string; prompt: string },
): Promise<PersonaCriticResult> {
  const prompt = `${persona.prompt}

## Messaging to Evaluate:
${content.substring(0, 3000)}

Respond with JSON:
{
  "score": <0-10>,
  "feedback": "<your honest, blunt reaction to this messaging — 2-3 sentences>",
  "strengths": ["<what works>"],
  "weaknesses": ["<what doesn't work>"]
}`;

  const response = await generateJSON<{
    score: number;
    feedback: string;
    strengths: string[];
    weaknesses: string[];
  }>(prompt, { temperature: 0.4, retryOnParseError: true, maxParseRetries: 2 });

  return {
    personaId: persona.id,
    personaName: persona.name,
    ...response.data,
  };
}
