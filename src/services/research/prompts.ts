export function buildResearchPrompt(
  painPointTitle: string,
  painPointContent: string,
  practitionerQuotes: string[],
  productDocs: string[],
  productName: string,
): string {
  const quotesSection = practitionerQuotes.length > 0
    ? `\n## Practitioner Quotes\n${practitionerQuotes.map(q => `> "${q}"`).join('\n')}`
    : '';

  const docsSection = productDocs.length > 0
    ? `\n## Product Context\n${productDocs.join('\n\n---\n\n')}`
    : '';

  return `Conduct deep research on this practitioner pain point and how it relates to competitive solutions.

## Pain Point
Title: ${painPointTitle}
Content: ${painPointContent}
${quotesSection}
${docsSection}

## Research Questions

1. **Product Capabilities**: How does ${productName} address this specific pain? What specific capabilities, features, or approaches does it offer? Be concrete — reference actual features if you can find them.

2. **Competitor Approaches**: How do the main competitors in this space address this pain? What do they offer? What are their strengths and limitations? Look at their documentation, blog posts, and customer feedback.

3. **Competitive Wedge**: Where does ${productName}'s approach win vs competitors for this specific pain? What's the differentiated story? What can ${productName} do that others can't, or do better?

4. **Practitioner Sentiment**: What do real practitioners say about existing solutions to this problem? Check Reddit, Stack Overflow, Hacker News, and community forums for authentic opinions. Copy exact quotes where possible.

5. **Market Context**: What industry trends make this pain more or less acute? Is this a growing problem? Are there emerging solutions?

## Output Requirements
- Be specific and factual, cite sources
- Include actual practitioner quotes from forums/communities
- Don't use marketing language — write like an analyst, not a vendor
- Focus on what actually works vs what vendors claim
- If you can't find solid information, say so — don't fabricate`;
}
