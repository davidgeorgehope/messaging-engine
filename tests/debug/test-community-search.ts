// Debug: reproduce the EXACT prompt that the outside-in pipeline sends to grounded search
import { extractInsights, formatInsightsForDiscovery } from '../../src/services/product/insights.js';
import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const apiKey = process.env.GOOGLE_AI_API_KEY!;
const client = new GoogleGenAI({ apiKey });

async function main() {
  // Load the same PDF used in tests
  const pdfPath = join(process.cwd(), 'data', 'uploads', 'mllhgsii-d39o46w3_One_Workflow__1_.pdf');
  const pdfBuffer = readFileSync(pdfPath);
  const productDocs = pdfBuffer.toString('base64');
  
  // Extract insights the same way the pipeline does
  console.log('Extracting insights from PDF...');
  const insights = await extractInsights(productDocs);
  if (!insights) {
    console.error('Failed to extract insights');
    return;
  }
  
  const discoveryContext = formatInsightsForDiscovery(insights);
  console.log('\n=== Discovery Context (fed to community search) ===');
  console.log(discoveryContext);
  console.log('=== End Discovery Context ===\n');
  
  // Build the EXACT same prompt as runCommunityDeepResearch
  const deepResearchPrompt = `Search Reddit, Hacker News, Stack Overflow, GitHub Issues, developer blogs, and other practitioner communities for real discussions, complaints, and pain points related to this product area.

## Product Area
${discoveryContext}

## What to Find
1. Real practitioner quotes expressing frustration with current tools in this space
2. Common complaints and pain points from community discussions
3. What practitioners wish existed or worked better
4. Specific scenarios where current solutions fail them
5. The language practitioners actually use to describe these problems

## Output Format
Organize findings as:
- **Practitioner Quotes**: Verbatim quotes from real community posts (include source URL and community name like "Reddit r/devops" or "HN comment")
- **Common Pain Points**: Recurring themes across communities
- **Wished-For Solutions**: What practitioners say they want
- **Language Patterns**: The specific words and phrases practitioners use (not vendor language)

Be specific. Include actual quotes with source URLs.`;

  console.log('=== Full prompt to grounded search ===');
  console.log(`Length: ${deepResearchPrompt.length}`);
  console.log(deepResearchPrompt);
  console.log('=== End prompt ===\n');
  
  // Call grounded search with this exact prompt
  console.log('Calling grounded search...');
  const start = Date.now();
  
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: deepResearchPrompt }] }],
    config: {
      maxOutputTokens: 8192,
      temperature: 0.3,
      tools: [{ googleSearch: {} }],
    },
  });
  
  const elapsed = Math.round((Date.now() - start) / 1000);
  const text = response.text ?? '';
  const groundingMetadata = (response.candidates?.[0] as any)?.groundingMetadata;
  const chunks = groundingMetadata?.groundingChunks ?? [];
  const queries = groundingMetadata?.webSearchQueries ?? [];
  
  console.log(`\nTime: ${elapsed}s`);
  console.log(`Text length: ${text.length}`);
  console.log(`Grounding chunks: ${chunks.length}`);
  console.log(`Search queries count: ${queries.length}`);
  
  if (text.length === 0) {
    console.log('\n*** EMPTY RESPONSE ***');
    console.log('Full candidate:', JSON.stringify(response.candidates?.[0], null, 2).substring(0, 2000));
  } else {
    console.log(`\nText preview: ${text.substring(0, 500)}`);
  }
}

main().catch(console.error);
