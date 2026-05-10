import type { GoogleGenAI } from '@google/genai';
import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';

export interface NewsSearchInput {
  query: string;
}

export interface NewsSearchResult {
  snippets: Array<{
    title: string;
    snippet: string;
    url: string;
    publishedAt?: string;
  }>;
  rawText: string;
}

export async function searchNews(
  genai: GoogleGenAI,
  input: NewsSearchInput,
): Promise<Result<NewsSearchResult>> {
  try {
    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: `Search for recent news and information about: ${input.query}\n\nProvide a thorough summary with key facts, relevant URLs, and publication dates where available.` }] }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text ?? '';
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const chunks = groundingMetadata?.groundingChunks ?? [];

    const snippets = chunks
      .filter((c): c is typeof c & { web: { uri: string; title: string } } => !!c.web?.uri)
      .map((c) => ({
        title: c.web.title ?? '',
        snippet: '',
        url: c.web.uri,
      }));

    return ok({ snippets, rawText: text });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
