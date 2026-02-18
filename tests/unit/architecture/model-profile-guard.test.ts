import { describe, it, expect } from 'vitest';

describe('model profile safety', () => {
  it('tests must run with economy profile to avoid burning Pro tokens', () => {
    // Either MODEL_PROFILE=economy is set explicitly, or VITEST is set (which config.ts uses to auto-select economy)
    const profile = process.env.MODEL_PROFILE;
    const vitest = process.env.VITEST;
    expect(
      profile === 'economy' || vitest,
      'MODEL_PROFILE must be "economy" or VITEST must be set — refusing to run tests against premium models'
    ).toBeTruthy();
  });
});
