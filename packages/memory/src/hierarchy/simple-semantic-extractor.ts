/**
 * Simple Semantic Extractor
 *
 * Minimal rule-based extraction: one fact per episode.
 * The fact's content is the episode topic. Real implementations
 * would use an LLM to extract multiple atomic facts.
 *
 * @module hierarchy/simple-semantic-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { SemanticExtractor } from '../interfaces/semantic-extractor.js';

export class SimpleSemanticExtractor implements SemanticExtractor {
  async extract(episode: Episode): Promise<SemanticFact[]> {
    const now = new Date();

    return [{
      id: crypto.randomUUID(),
      content: episode.topic,
      source_episode_ids: [episode.id],
      entity_ids: [],
      provenance: {
        source: 'system',
        created_at: now,
      },
      valid_from: episode.started_at,
    }];
  }
}
