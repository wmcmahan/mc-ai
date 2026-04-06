/**
 * Semantic Extractor Interface
 *
 * Distills episodes into atomic semantic facts.
 * Level 1 → Level 2 of the xMemory hierarchy.
 *
 * @module interfaces/semantic-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';

export interface SemanticExtractor {
  /** Extract atomic facts from an episode. */
  extract(episode: Episode): Promise<SemanticFact[]>;
}
