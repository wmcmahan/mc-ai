/**
 * Episode Schema — Message Groups
 *
 * Level 1 of the xMemory hierarchy. Messages are grouped into
 * topic-coherent episodes. A topic shift triggers a new episode.
 *
 * @module schemas/episode
 */

import { z } from 'zod';
import { ProvenanceSchema } from './provenance.js';

/** A single message within a conversation or agent interaction. */
export const MessageSchema = z.object({
  /** Unique message identifier. */
  id: z.string().uuid(),
  /** Message role. */
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  /** Message content. */
  content: z.string(),
  /** When this message was produced. */
  timestamp: z.coerce.date(),
  /** Arbitrary metadata (e.g. tool call IDs, model info). */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type Message = z.infer<typeof MessageSchema>;

/** A coherent group of messages about one topic. */
export const EpisodeSchema = z.object({
  /** Unique episode identifier. */
  id: z.string().uuid(),
  /** Short topic label for this episode. */
  topic: z.string(),
  /** Messages in this episode, ordered by timestamp. */
  messages: z.array(MessageSchema),
  /** Timestamp of the first message. */
  started_at: z.coerce.date(),
  /** Timestamp of the last message. */
  ended_at: z.coerce.date(),
  /** Optional embedding vector for the episode. */
  embedding: z.array(z.number()).optional(),
  /** IDs of semantic facts extracted from this episode. */
  fact_ids: z.array(z.string().uuid()).default([]),
  /** Origin metadata. */
  provenance: ProvenanceSchema,
});

export type Episode = z.infer<typeof EpisodeSchema>;

/** Input shape for creating an episode (no `id` required). */
export type EpisodeInput = Omit<Episode, 'id'> & { id?: string };
