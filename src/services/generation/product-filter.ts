// Product document relevance filtering
// Scores and filters product docs by keyword overlap with pain point and priority context
// Pure function — no AI calls, no side effects

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('generation:product-filter');

interface FilterableDoc {
  id: string;
  name: string;
  content: string;
  description?: string;
  tags?: string[];
}

interface FilterContext {
  painPointTitle: string;
  painPointKeywords: string[];
  priorityKeywords: string[];
}

/**
 * Filters product documents by relevance to the current generation context.
 * Returns the topN most relevant docs, or all docs if scores are all zero or fewer than topN exist.
 */
export function filterRelevantDocs(
  docs: FilterableDoc[],
  context: FilterContext,
  topN: number = 3,
): FilterableDoc[] {
  if (docs.length <= topN) return docs;

  // Build keyword set from all context sources
  const keywords = buildKeywords(context);
  if (keywords.length === 0) return docs;

  // Score each doc
  const scored = docs.map(doc => ({
    doc,
    score: scoreDoc(doc, keywords),
  }));

  // If all scores are 0, return all (fallback to current behavior)
  const maxScore = Math.max(...scored.map(s => s.score));
  if (maxScore === 0) {
    logger.debug('All docs scored 0, returning all', { count: docs.length });
    return docs;
  }

  // Sort by score descending, take topN
  scored.sort((a, b) => b.score - a.score);
  const filtered = scored.slice(0, topN).map(s => s.doc);

  logger.info('Filtered product docs', {
    total: docs.length,
    selected: filtered.length,
    topScore: scored[0]?.score,
    bottomScore: scored[scored.length - 1]?.score,
  });

  return filtered;
}

function buildKeywords(context: FilterContext): string[] {
  const words = new Set<string>();

  // Pain point keywords (from painAnalysis)
  for (const kw of context.painPointKeywords) {
    words.add(kw.toLowerCase());
  }

  // Priority keywords
  for (const kw of context.priorityKeywords) {
    words.add(kw.toLowerCase());
  }

  // Significant words from pain point title (3+ chars, not stop words)
  const titleWords = extractSignificantWords(context.painPointTitle);
  for (const w of titleWords) {
    words.add(w);
  }

  return Array.from(words);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'was', 'are', 'be',
  'has', 'had', 'have', 'not', 'this', 'that', 'they', 'we', 'you',
  'how', 'why', 'what', 'when', 'where', 'which', 'who', 'all', 'can',
  'will', 'do', 'does', 'did', 'been', 'being', 'its', 'my', 'our',
  'their', 'your', 'more', 'most', 'very', 'just', 'about', 'than',
]);

function extractSignificantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

function scoreDoc(doc: FilterableDoc, keywords: string[]): number {
  let score = 0;

  const tagsLower = (doc.tags ?? []).map(t => t.toLowerCase());
  const descLower = (doc.description ?? '').toLowerCase();
  const contentStart = doc.content.substring(0, 1000).toLowerCase();
  const nameLower = doc.name.toLowerCase();

  for (const keyword of keywords) {
    // Tag overlap (weight 3)
    if (tagsLower.some(tag => tag.includes(keyword) || keyword.includes(tag))) {
      score += 3;
    }

    // Description match (weight 2)
    if (descLower.includes(keyword)) {
      score += 2;
    }

    // Content first 1000 chars (weight 1)
    if (contentStart.includes(keyword)) {
      score += 1;
    }

    // Doc name match (weight 1)
    if (nameLower.includes(keyword)) {
      score += 1;
    }
  }

  return score;
}
