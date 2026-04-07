/**
 * LLM-Backed Semantic Extractor
 *
 * Uses an injectable LLM provider to extract structured facts from
 * episodes. Falls back to the RuleBasedExtractor on any failure.
 *
 * Includes a timeout guard and a consecutive-failure circuit breaker
 * that skips the LLM call and goes straight to rule-based extraction
 * when the provider is repeatedly failing.
 *
 * @module hierarchy/llm-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';
import type { SemanticExtractor, ExtractionResult } from '../interfaces/semantic-extractor.js';
import { RuleBasedExtractor } from './rule-based-extractor.js';

export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

export interface LLMExtractorOptions {
  provider: LLMProvider;
  maxFactsPerEpisode?: number;
  /** Timeout in milliseconds for LLM provider calls (default: 30000). */
  timeoutMs?: number;
  /** Skip LLM after this many consecutive failures (default: 3). */
  maxConsecutiveFailures?: number;
  /** After tripping the breaker, retry the LLM after this many milliseconds (default: 60000). */
  breakerCooldownMs?: number;
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
  private readonly timeoutMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly breakerCooldownMs: number;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private breakerTrippedAt: number | null = null;

  constructor(options: LLMExtractorOptions) {
    this.provider = options.provider;
    this.maxFacts = options.maxFactsPerEpisode ?? 20;
    this.fallback = new RuleBasedExtractor();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.breakerCooldownMs = options.breakerCooldownMs ?? 60_000;
  }

  async extract(episode: Episode): Promise<ExtractionResult> {
    // Circuit breaker: skip LLM if repeatedly failing
    if (this.isBreakerOpen()) {
      return this.fallback.extract(episode);
    }

    try {
      const prompt = this.buildPrompt(episode);
      const response = await this.callWithTimeout(prompt);
      const result = this.parseResponse(response, episode);
      if (result === null) {
        this.recordFailure();
        return this.fallback.extract(episode);
      }
      this.recordSuccess();
      return result;
    } catch (err) {
      console.warn('LLMExtractor failed, falling back to RuleBasedExtractor:', err);
      this.recordFailure();
      return this.fallback.extract(episode);
    }
  }

  private async callWithTimeout(prompt: string): Promise<string> {
    return Promise.race([
      this.provider.complete(prompt),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`LLMExtractor: timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      }),
    ]);
  }

  private isBreakerOpen(): boolean {
    if (this.consecutiveFailures < this.maxConsecutiveFailures) return false;
    if (this.breakerTrippedAt === null) return false;
    // Cooldown elapsed — allow one retry
    if (Date.now() - this.breakerTrippedAt >= this.breakerCooldownMs) {
      return false;
    }
    return true;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.breakerTrippedAt = Date.now();
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerTrippedAt = null;
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

  private parseResponse(response: string, episode: Episode): ExtractionResult | null {
    const now = new Date();
    const entityNameToId = new Map<string, string>();
    const entityNameToType = new Map<string, string>();

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
      return null;
    }

    // Must be an array
    if (!Array.isArray(parsed)) {
      console.warn('LLMExtractor: response is not an array, falling back');
      return null;
    }

    const llmFacts = parsed as LLMFactOutput[];
    const facts: SemanticFact[] = [];
    const relationships: Relationship[] = [];

    for (const item of llmFacts) {
      if (facts.length >= this.maxFacts) break;

      if (!item.content || typeof item.content !== 'string') continue;

      const entityIds: string[] = [];
      if (Array.isArray(item.entities)) {
        for (const ent of item.entities) {
          if (!ent.name) continue;
          if (!entityNameToId.has(ent.name)) {
            entityNameToId.set(ent.name, crypto.randomUUID());
            entityNameToType.set(ent.name, ent.type ?? 'concept');
          }
          entityIds.push(entityNameToId.get(ent.name)!);
        }
      }

      // Process relationships from LLM output
      if (Array.isArray(item.relationships)) {
        for (const rel of item.relationships) {
          if (!rel.source || !rel.target || !rel.type) continue;
          const sourceId = entityNameToId.get(rel.source);
          const targetId = entityNameToId.get(rel.target);
          if (sourceId && targetId) {
            relationships.push({
              id: crypto.randomUUID(),
              source_id: sourceId,
              target_id: targetId,
              relation_type: rel.type,
              weight: 1,
              attributes: {},
              valid_from: episode.started_at,
              provenance: { source: 'derived' as const, created_at: now },
            });
          }
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

    // Build Entity records from the name→id map
    const entities: Entity[] = [...entityNameToId.entries()].map(([name, id]) => ({
      id,
      name,
      entity_type: entityNameToType.get(name) ?? 'concept',
      attributes: {},
      provenance: { source: 'derived' as const, created_at: now },
      created_at: now,
      updated_at: now,
    }));

    return { facts, entities, relationships };
  }
}
