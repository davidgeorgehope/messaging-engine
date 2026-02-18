import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('go-outside source presence', () => {
  const actionsPath = join(ROOT, 'src/services/workspace/actions.ts');
  const routesPath = join(ROOT, 'src/api/workspace/sessions.ts');

  it('actions.ts exports runCompetitiveDeepDiveAction', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+runCompetitiveDeepDiveAction/);
  });

  it('actions.ts exports runCommunityCheckAction', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+runCommunityCheckAction/);
  });

  it('actions.ts uses Deep Research for community check (not individual adapters)', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toContain('createDeepResearchInteraction');
    expect(source).not.toContain('discoverFromReddit');
    expect(source).not.toContain('discoverFromHackerNews');
    expect(source).not.toContain('discoverFromStackOverflow');
    expect(source).not.toContain('discoverFromGitHub');
    expect(source).not.toContain('discoverFromDiscourse');
  });

  it('actions.ts does NOT contain naive regex keyword splitting', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).not.toMatch(/\.split\(\/\[\\s,\./);
  });

  it('actions.ts does NOT contain hardcoded inferSubreddits function', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).not.toMatch(/function\s+inferSubreddits/);
  });

  it('API routes exist for both actions', () => {
    const source = readFileSync(routesPath, 'utf-8');
    expect(source).toContain('actions/competitive-dive');
    expect(source).toContain('actions/community-check');
  });
});

// After pipeline extraction, these patterns live in src/services/pipeline/ modules
// We read from the specific module files rather than the monolithic generate.ts
describe('evidence grounding in pipeline modules', () => {
  const evidencePath = join(ROOT, 'src/services/pipeline/evidence.ts');
  const orchestratorPath = join(ROOT, 'src/services/pipeline/orchestrator.ts');
  const promptsPath = join(ROOT, 'src/services/pipeline/prompts.ts');
  const outsideInPath = join(ROOT, 'src/services/pipeline/pipelines/outside-in.ts');
  const multiPerspectivePath = join(ROOT, 'src/services/pipeline/pipelines/multi-perspective.ts');

  it('defines EvidenceBundle type', () => {
    const source = readFileSync(evidencePath, 'utf-8');
    expect(source).toContain('interface EvidenceBundle');
  });

  it('runCommunityDeepResearch returns EvidenceBundle', () => {
    const source = readFileSync(evidencePath, 'utf-8');
    expect(source).toMatch(/async function runCommunityDeepResearch.*Promise<EvidenceBundle>/);
  });

  it('evidence.ts uses Deep Research for community discovery (not grounded search)', () => {
    const source = readFileSync(evidencePath, 'utf-8');
    expect(source).toContain('createDeepResearchInteraction');
    expect(source).not.toContain('generateWithGeminiGroundedSearch');
    expect(source).not.toContain('extractKeywordsAndSources');
  });

  it('storeVariant accepts evidence bundle parameter', () => {
    const source = readFileSync(orchestratorPath, 'utf-8');
    expect(source).toMatch(/async function storeVariant[\s\S]*?evidence\?: EvidenceBundle/);
  });

  it('storeVariant uses real practitioner quotes from evidence bundle', () => {
    const source = readFileSync(orchestratorPath, 'utf-8');
    expect(source).not.toMatch(/practitionerQuotes:\s*JSON\.stringify\(\[\]\)/);
    expect(source).toMatch(/evidence\?\.practitionerQuotes/);
  });

  it('buildSystemPrompt includes anti-fabrication rules for product-only evidence', () => {
    const source = readFileSync(promptsPath, 'utf-8');
    expect(source).toContain('You have NO community evidence');
    expect(source).toContain('Do NOT fabricate practitioner quotes');
  });

  it('buildSystemPrompt constrains use of real evidence when available', () => {
    const source = readFileSync(promptsPath, 'utf-8');
    expect(source).toContain('ONLY reference practitioners and quotes from the "Verified Community Evidence" section');
  });

  it('outside-in pipeline throws when no evidence (no silent fallback)', () => {
    const source = readFileSync(outsideInPath, 'utf-8');
    expect(source).toContain("Outside-in pipeline requires real community evidence");
    expect(source).toContain("throw new Error");
  });

  it('default generation model is Gemini (not Claude)', () => {
    const source = readFileSync(orchestratorPath, 'utf-8');
    expect(source).toMatch(/Default.*Gemini/i);
    expect(source).toContain("model.includes('claude')");
  });

  it('competitive research uses extracted insights, not naive truncation', () => {
    const source = readFileSync(evidencePath, 'utf-8');
    expect(source).not.toMatch(/productDocs\.substring\(0,\s*10000\)/);
    expect(source).toMatch(/buildResearchPromptFromInsights/);
    const promptsSource = readFileSync(promptsPath, 'utf-8');
    expect(promptsSource).toMatch(/formatInsightsForResearch/);
  });

  it('storeVariant calls validateGrounding before storage', () => {
    const source = readFileSync(orchestratorPath, 'utf-8');
    expect(source).toContain('validateGrounding');
  });

  it('writes evidence_level to messaging_assets', () => {
    const source = readFileSync(orchestratorPath, 'utf-8');
    expect(source).toMatch(/evidenceLevel:\s*evidence\?\.evidenceLevel/);
  });

  it('Multi-Perspective generates 3 perspectives in parallel via Promise.all', () => {
    const source = readFileSync(multiPerspectivePath, 'utf-8');
    // Multi-perspective runs 3 perspective generations in parallel
    const parallelPattern = /Promise\.all\(\[\s*\n?\s*generateContent/g;
    const matches = source.match(parallelPattern);
    expect(matches?.length).toBe(1);
  });
});

describe('grounding-validator.ts', () => {
  const validatorPath = join(ROOT, 'src/services/quality/grounding-validator.ts');

  it('exists and exports validateGrounding', () => {
    const source = readFileSync(validatorPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+validateGrounding/);
  });

  it('uses LLM-based fabrication detection (domain-agnostic)', () => {
    const source = readFileSync(validatorPath, 'utf-8');
    expect(source).toContain('generateJSON');
    expect(source).toContain('fabricatedReferences');
    // No hardcoded regex patterns
    expect(source).not.toContain('FABRICATION_PATTERNS');
    expect(source).not.toContain('SRE|DevOps');
  });

  it('skips check for grounded content, only checks product-only', () => {
    const source = readFileSync(validatorPath, 'utf-8');
    expect(source).toContain("evidenceLevel === 'strong'");
    expect(source).toContain("evidenceLevel === 'partial'");
  });
});

describe('default pipeline is outside-in', () => {
  it('schema defaults to outside-in pipeline', () => {
    const schemaPath = join(ROOT, 'src/db/schema.ts');
    const source = readFileSync(schemaPath, 'utf-8');
    expect(source).toContain("pipeline: text('pipeline').default('outside-in')");
  });

  it('admin UI defaults to outside-in pipeline', () => {
    const uiPath = join(ROOT, 'admin/src/pages/workspace/NewSession.tsx');
    const source = readFileSync(uiPath, 'utf-8');
    expect(source).toContain("useState('outside-in')");
  });
});
