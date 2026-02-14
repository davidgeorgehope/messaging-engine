import { describe, it, expect } from 'vitest';

/**
 * Tests the ---PROPOSED--- delimiter extraction pattern used in
 * src/api/workspace/chat.ts (line 126) for accepting proposed content.
 *
 * The pattern:
 *   const match = msg.content.match(/---PROPOSED---([\s\S]*?)---PROPOSED---/);
 *   const content = match ? match[1].trim() : msg.content.trim();
 */
function extractProposedContent(rawContent: string): string {
  const match = rawContent.match(/---PROPOSED---([\s\S]*?)---PROPOSED---/);
  return match ? match[1].trim() : rawContent.trim();
}

describe('---PROPOSED--- delimiter extraction', () => {
  it('should extract content between ---PROPOSED--- delimiters', () => {
    const input = 'Some preamble\n---PROPOSED---\nThis is the proposed content.\n---PROPOSED---\nSome epilogue';
    expect(extractProposedContent(input)).toBe('This is the proposed content.');
  });

  it('should ignore content outside the delimiters', () => {
    const input = 'IGNORED before\n---PROPOSED---\nKEPT\n---PROPOSED---\nIGNORED after';
    expect(extractProposedContent(input)).toBe('KEPT');
  });

  it('should use full content when no delimiters are present', () => {
    const input = 'Just some regular content without any delimiters.';
    expect(extractProposedContent(input)).toBe('Just some regular content without any delimiters.');
  });

  it('should trim whitespace from extracted content', () => {
    const input = '---PROPOSED---\n\n   Padded content   \n\n---PROPOSED---';
    expect(extractProposedContent(input)).toBe('Padded content');
  });

  it('should trim whitespace when falling back to full content', () => {
    const input = '   Some content with leading/trailing spaces   ';
    expect(extractProposedContent(input)).toBe('Some content with leading/trailing spaces');
  });

  it('should use only the first match when multiple delimiter pairs exist', () => {
    const input = '---PROPOSED---\nFirst block\n---PROPOSED---\nMiddle\n---PROPOSED---\nSecond block\n---PROPOSED---';
    expect(extractProposedContent(input)).toBe('First block');
  });

  it('should return empty string for empty content between delimiters', () => {
    const input = '---PROPOSED------PROPOSED---';
    expect(extractProposedContent(input)).toBe('');
  });

  it('should handle whitespace-only content between delimiters', () => {
    const input = '---PROPOSED---   \n\n   ---PROPOSED---';
    expect(extractProposedContent(input)).toBe('');
  });

  it('should handle multiline proposed content', () => {
    const input = '---PROPOSED---\nLine 1\nLine 2\nLine 3\n---PROPOSED---';
    expect(extractProposedContent(input)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('should handle content with special characters', () => {
    const input = '---PROPOSED---\n## Heading\n- bullet $100 *bold* (parens)\n---PROPOSED---';
    expect(extractProposedContent(input)).toBe('## Heading\n- bullet $100 *bold* (parens)');
  });

  it('should not match with only one delimiter', () => {
    const input = '---PROPOSED---\nThis has only an opening delimiter';
    expect(extractProposedContent(input)).toBe('---PROPOSED---\nThis has only an opening delimiter');
  });
});
