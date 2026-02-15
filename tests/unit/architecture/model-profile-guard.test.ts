import { describe, it, expect } from 'vitest';

describe('model profile safety', () => {
  it('tests must run with test profile to avoid burning Pro tokens', () => {
    // Either MODEL_PROFILE=test is set explicitly, or VITEST is set (which config.ts uses to auto-select test)
    const profile = process.env.MODEL_PROFILE;
    const vitest = process.env.VITEST;
    expect(
      profile === 'test' || vitest,
      'MODEL_PROFILE must be "test" or VITEST must be set — refusing to run tests against production models'
    ).toBeTruthy();
  });
});
