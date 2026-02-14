export type AssetType = 'battlecard' | 'talk_track' | 'launch_messaging' | 'social_hook' | 'one_pager' | 'email_copy' | 'messaging_template' | 'narrative';

export type GenerationStep = 'research' | 'context' | 'generate' | 'score' | 'stress_test' | 'store';

export interface GenerationContext {
  painPoint: {
    id: string;
    title: string;
    content: string;
    practitionerQuotes: string[];
    painAnalysis: Record<string, unknown>;
  };
  priority: {
    id: string;
    name: string;
    keywords: string[];
  };
  competitiveResearch?: {
    researchId: string;
    rawReport: string;
    structuredAnalysis: Record<string, unknown>;
    sources: Array<{ title: string; url: string }>;
  };
  productDocs: Array<{
    id: string;
    name: string;
    content: string;
  }>;
  voiceProfiles: Array<{
    id: string;
    name: string;
    slug: string;
    voiceGuide: string;
    scoringThresholds: ScoringThresholds;
  }>;
  assetTypes: AssetType[];
}

export interface ScoringThresholds {
  slopMax: number;
  vendorSpeakMax: number;
  authenticityMin: number;
  specificityMin: number;
  personaMin: number;
}

export interface GeneratedVariant {
  voiceProfileId: string;
  variantNumber: number;
  content: string;
  assetType: AssetType;
}

export interface ScoredVariant extends GeneratedVariant {
  slopScore: number;
  vendorSpeakScore: number;
  authenticityScore: number;
  specificityScore: number;
  personaAvgScore: number;
  passesGates: boolean;
}

export interface MessagingGenerationResult {
  assetId: string;
  variants: ScoredVariant[];
  traceability: {
    painPointId: string;
    researchId?: string;
    productDocIds: string[];
    practitionerQuotes: string[];
  };
}
