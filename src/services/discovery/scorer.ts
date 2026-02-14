import { generateJSON } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';
import type { RawDiscoveredPainPoint, ScoredPainPoint, PainAnalysis } from './types.js';
import { hashContent } from '../../utils/hash.js';

const logger = createLogger('discovery:scorer');

export async function scorePainPoints(posts: RawDiscoveredPainPoint[]): Promise<ScoredPainPoint[]> {
  const scored: ScoredPainPoint[] = [];

  // Process in batches of 5
  for (let i = 0; i < posts.length; i += 5) {
    const batch = posts.slice(i, i + 5);
    const results = await Promise.all(batch.map(post => scorePost(post)));
    scored.push(...results);

    // Rate limiting between batches
    if (i + 5 < posts.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return scored;
}

async function scorePost(post: RawDiscoveredPainPoint): Promise<ScoredPainPoint> {
  try {
    const prompt = `Analyze this community post as a potential source for product messaging.

TITLE: ${post.title}
CONTENT: ${post.content.substring(0, 3000)}
SOURCE: ${post.sourceType}

Evaluate and respond with JSON:
{
  "score": <0-100 pain score>,
  "reasoning": "<why this score>",
  "authorLevel": "beginner" | "intermediate" | "advanced",
  "painPoints": ["<specific pain points expressed>"],
  "emotionalIndicators": ["<frustration, confusion, etc>"],
  "technicalDepth": <1-10>,
  "urgency": <1-10>,
  "specificity": <1-10>,
  "messagingRelevance": <1-10, how usable is this pain for product messaging?>,
  "extractedQuotes": ["<exact quotes from the post that express pain, frustration, or needs — copy verbatim>"]
}

Score higher for:
- Specific, real-world pain (not theoretical)
- Practitioner language (not vendor language)
- Clear emotional indicators (frustration, time wasted, etc)
- Quotable phrases that could anchor messaging
- Pain that maps to product capabilities

Score lower for:
- Generic questions without pain
- Vendor marketing content
- Already-solved problems
- Low specificity`;

    const response = await generateJSON<PainAnalysis>(prompt, {
      temperature: 0.3,
    });

    const analysis = response.data;

    return {
      ...post,
      painScore: analysis.score,
      painAnalysis: analysis,
      practitionerQuotes: analysis.extractedQuotes || [],
      authorLevel: analysis.authorLevel,
      contentHash: hashContent(post.title + post.content),
    };
  } catch (error) {
    logger.error('Failed to score post', { title: post.title, error });
    return {
      ...post,
      painScore: 0,
      painAnalysis: {
        score: 0,
        reasoning: 'Scoring failed',
        authorLevel: 'beginner',
        painPoints: [],
        emotionalIndicators: [],
        technicalDepth: 0,
        urgency: 0,
        specificity: 0,
        messagingRelevance: 0,
        extractedQuotes: [],
      },
      practitionerQuotes: [],
      authorLevel: 'beginner',
      contentHash: hashContent(post.title + post.content),
    };
  }
}
