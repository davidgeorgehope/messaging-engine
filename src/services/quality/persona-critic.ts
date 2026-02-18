// Persona stress testing
// Runs messaging through AI critic personas that represent target audience segments
// Each persona scores 0-10 and provides blunt feedback
// Personas are LLM-generated from product insights — domain-agnostic

import { generateJSON } from '../ai/clients.js';
import { getModelForTask } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:persona-critic');

export interface PersonaCriticResult {
  personaId: string;
  personaName: string;
  score: number;  // 0-10
  feedback: string;
  strengths: string[];
  weaknesses: string[];
}

export interface PersonaScoringContext {
  domain: string;
  category: string;
  targetPersonas: string[];
  painPointsAddressed: string[];
  productName: string;
}

interface Persona {
  id: string;
  name: string;
  prompt: string;
}

// In-memory cache keyed by domain:category — avoids regenerating within the same process
const personaCache = new Map<string, Persona[]>();

function getGenericFallbackPersonas(): Persona[] {
  return [
    {
      id: 'generic-skeptic',
      name: 'Skeptical Senior Practitioner',
      prompt: `You are a senior practitioner with 12+ years of experience in your field. You've been burned by vendor promises before and you're deeply skeptical of marketing claims. You value: specificity, honesty about limitations, understanding of real operational pain, and respect for your time. You hate: buzzwords, hand-wavy claims, anything that sounds like it was written by someone who doesn't do the actual work. Score this messaging 0-10 and be brutally honest.`,
    },
    {
      id: 'generic-budget',
      name: 'Cost-Conscious Technical Lead',
      prompt: `You are a technical lead at a mid-size company. Your budget is tight and getting tighter. You evaluate everything through the lens of: does this actually save money or time? Is this a real need or a nice-to-have? You're tired of tools that promise the world and deliver marginal improvements. Score this messaging 0-10 based on whether it would make you want to learn more, and be specific about what works and what doesn't.`,
    },
    {
      id: 'generic-pragmatist',
      name: 'Busy Practitioner Who Hates Complexity',
      prompt: `You are a practitioner who views tooling as a means to an end. You just want to get your work done and not spend hours configuring, learning, or maintaining yet another tool. You're suspicious of any tool that requires "just a few minutes of setup" (it never is). You value: simplicity, good developer experience, not having to learn yet another query language or config format. Score this messaging 0-10 on whether it speaks to your reality.`,
    },
  ];
}

async function generatePersonasForContext(context: PersonaScoringContext): Promise<Persona[]> {
  const cacheKey = `${context.domain}:${context.category}`;
  const cached = personaCache.get(cacheKey);
  if (cached) return cached;

  try {
    const prompt = `Generate 3 critic personas who would evaluate messaging for a product in the "${context.domain}" domain, specifically in the "${context.category}" category.

The product is called "${context.productName}" and targets these personas: ${context.targetPersonas.join(', ')}.

Key pain points it addresses: ${context.painPointsAddressed.slice(0, 5).join('; ')}.

For each persona, create:
- A short descriptive name (e.g. "Skeptical Senior DBA", "Budget-Conscious Security Lead")
- A detailed scoring prompt that captures their perspective, concerns, and what they value/hate in vendor messaging

The personas should represent:
1. A skeptical senior practitioner in the "${context.domain}" space who has deep experience and is hard to impress
2. A budget-conscious decision-maker who cares about ROI and concrete value
3. A hands-on practitioner who cares most about usability and practical impact

Return a JSON array of 3 objects, each with "name" (string) and "prompt" (string — the full scoring instructions for this persona, ending with "Score this messaging 0-10").`;

    const response = await generateJSON<Array<{ name: string; prompt: string }>>(prompt, {
      model: getModelForTask('flash'),
      temperature: 0.4,
      retryOnParseError: true,
      maxParseRetries: 2,
    });

    const personas: Persona[] = response.data.map((p, i) => ({
      id: `generated-${i}`,
      name: p.name,
      prompt: p.prompt,
    }));

    personaCache.set(cacheKey, personas);
    return personas;
  } catch (error) {
    logger.warn('Failed to generate personas from context, using generic fallbacks', {
      domain: context.domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return getGenericFallbackPersonas();
  }
}

export async function runPersonaCritics(content: string, personaContext?: PersonaScoringContext): Promise<PersonaCriticResult[]> {
  const personas = personaContext
    ? await generatePersonasForContext(personaContext)
    : getGenericFallbackPersonas();

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
