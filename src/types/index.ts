// Centralized type definitions for messaging-engine
// Re-exports Drizzle inferred types and adds domain-specific interfaces

export type {
  VoiceProfile,
  Session,
  SessionVersion,
  GenerationJob,
  ProductDocument,
} from '../db/schema.js';

import type { ScoreResults, ScorerHealth } from '../services/quality/score-content.js';
import type { SlopAnalysis } from '../services/quality/slop-detector.js';

export type { ScoreResults, ScorerHealth } from '../services/quality/score-content.js';

export interface ScoringThresholds {
  slopMax: number;
  vendorSpeakMax: number;
  authenticityMin: number;
  specificityMin: number;
  personaMin: number;
  narrativeArcMin: number;
}

export const DEFAULT_SCORING_THRESHOLDS: ScoringThresholds = {
  slopMax: 5,
  vendorSpeakMax: 5,
  authenticityMin: 6,
  specificityMin: 6,
  personaMin: 6,
  narrativeArcMin: 5,
};

export function parseScoringThresholds(raw: string | null): ScoringThresholds {
  if (!raw) return { ...DEFAULT_SCORING_THRESHOLDS };
  try {
    const parsed = JSON.parse(raw);
    return {
      slopMax: parsed.slopMax ?? DEFAULT_SCORING_THRESHOLDS.slopMax,
      vendorSpeakMax: parsed.vendorSpeakMax ?? DEFAULT_SCORING_THRESHOLDS.vendorSpeakMax,
      authenticityMin: parsed.authenticityMin ?? DEFAULT_SCORING_THRESHOLDS.authenticityMin,
      specificityMin: parsed.specificityMin ?? DEFAULT_SCORING_THRESHOLDS.specificityMin,
      personaMin: parsed.personaMin ?? DEFAULT_SCORING_THRESHOLDS.personaMin,
      narrativeArcMin: parsed.narrativeArcMin ?? DEFAULT_SCORING_THRESHOLDS.narrativeArcMin,
    };
  } catch {
    return { ...DEFAULT_SCORING_THRESHOLDS };
  }
}

export interface PipelineStepData {
  draft?: string;
  scores?: ScoreResults;
  model?: string;
  scorerHealth?: ScorerHealth;
}

export interface PipelineStep {
  step: string;
  status: 'running' | 'complete';
  startedAt: string;
  completedAt?: string;
  model?: string;
  draft?: string;
  scores?: ScoreResults;
  scorerHealth?: ScorerHealth;
}

export interface PersonaCriticResult {
  score: number;
  feedback?: string;
}
