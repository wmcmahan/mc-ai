/**
 * Provenance Schema
 *
 * Tracks the origin of memory records — which agent, tool, or human
 * produced a piece of data and when. Compatible with (but independent of)
 * the orchestrator's TaintMetadata system.
 *
 * @module schemas/provenance
 */

import { z } from 'zod';

export const ProvenanceSchema = z.object({
  /** Origin category. */
  source: z.enum(['agent', 'tool', 'human', 'system', 'derived']),
  /** Agent that produced the data (when `source` is `"agent"` or `"derived"`). */
  agent_id: z.string().optional(),
  /** Tool that produced the data (when `source` is `"tool"`). */
  tool_name: z.string().optional(),
  /** Workflow run that produced the data. */
  run_id: z.string().optional(),
  /** Graph node that produced the data. */
  node_id: z.string().optional(),
  /** Extraction confidence score (0–1). */
  confidence: z.number().min(0).max(1).optional(),
  /** When this record was created. */
  created_at: z.coerce.date(),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;
