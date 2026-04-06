/**
 * LLM-Backed Semantic Extractor
 *
 * Uses an injectable LLM provider to extract structured facts from
 * episodes. Falls back to the RuleBasedExtractor on any failure.
 *
 * @module hierarchy/llm-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { SemanticExtractor } from '../interfaces/semantic-extractor.js';
import { RuleBasedExtractor } from './rule-based-extractor.js';

export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

export interface LLMExtractorOptions {
  provider: LLMProvider;
  maxFactsPerEpisode?: number;
}

interface LLMFactOutput {
  content: string;
  entities?: Array<{ name: string; type?: string }>;
  relationships?: Array<{ source: string; target: string; type: string }>;
}

export class LLMExtractor implements SemanticExtractor {
  private readonly provider: LLMProvider;
  private readonly maxFacts: number;
  private readonly fallback: RuleBasedExtractor;

  constructor(options: LLMExtractorOptions) {
    this.provider = options.provider;
    this.maxFacts = options.maxFactsPerEpisode ?? 20;
    this.fallback = new RuleBasedExtractor();
  }

  async extract(episode: Episode): Promise<SemanticFact[]> {
    try {
      const prompt = this.buildPrompt(episode);
      const response = await this.provider.complete(prompt);
      return this.parseResponse(response, episode);
    } catch (err) {
      console.warn('LLMExtractor failed, falling back to RuleBasedExtractor:', err);
      return this.fallback.extract(episode);
    }
  }

  private buildPrompt(episode: Episode): string {
    const messagesText = episode.messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');

    return `Read the following conversation messages and extract atomic facts as a JSON array.

Each fact object must have:
- "content": a single atomic fact as a sentence
- "entities": array of { "name": "...", "type": "person|organization|concept|tool|location" }
- "relationships": array of { "source": "...", "target": "...", "type": "..." }

Response must be ONLY the JSON array, no other text.

Messages:
${messagesText}`;
  }

  private parseResponse(response: string, episode: Episode): SemanticFact[] {
    const now = new Date();
    const entityNameToId = new Map<string, string>();

    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = response.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.warn('LLMExtractor: failed to parse JSON, falling back');
      // Synchronous fallback — create a new extractor and extract
      return this.extractFallbackSync(episode);
    }

    // Must be an array
    if (!Array.isArray(parsed)) {
      console.warn('LLMExtractor: response is not an array, falling back');
      return this.extractFallbackSync(episode);
    }

    const llmFacts = parsed as LLMFactOutput[];
    const facts: SemanticFact[] = [];

    for (const item of llmFacts) {
      if (facts.length >= this.maxFacts) break;

      if (!item.content || typeof item.content !== 'string') continue;

      const entityIds: string[] = [];
      if (Array.isArray(item.entities)) {
        for (const ent of item.entities) {
          if (!ent.name) continue;
          if (!entityNameToId.has(ent.name)) {
            entityNameToId.set(ent.name, crypto.randomUUID());
          }
          entityIds.push(entityNameToId.get(ent.name)!);
        }
      }

      facts.push({
        id: crypto.randomUUID(),
        content: item.content,
        source_episode_ids: [episode.id],
        entity_ids: entityIds,
        provenance: {
          source: 'derived',
          created_at: now,
        },
        valid_from: episode.started_at,
      });
    }

    return facts;
  }

  /**
   * Synchronous-safe fallback: we cannot await inside parseResponse
   * since it's not async. Instead, we throw to let the outer catch handle it.
   */
  private extractFallbackSync(episode: Episode): never {
    throw new Error('parse-failed');
  }
}
