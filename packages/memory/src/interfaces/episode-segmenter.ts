/**
 * Episode Segmenter Interface
 *
 * Groups raw messages into topic-coherent episodes.
 * Level 0 → Level 1 of the xMemory hierarchy.
 *
 * @module interfaces/episode-segmenter
 */

import type { Message, Episode } from '../schemas/episode.js';

export interface EpisodeSegmenter {
  /** Segment messages into coherent episodes. */
  segment(messages: Message[]): Promise<Episode[]>;
}
