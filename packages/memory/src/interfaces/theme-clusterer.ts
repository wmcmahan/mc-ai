/**
 * Theme Clusterer Interface
 *
 * Groups semantic facts into thematic clusters.
 * Level 2 → Level 3 of the xMemory hierarchy.
 *
 * @module interfaces/theme-clusterer
 */

import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';

export interface ThemeClusterer {
  /** Cluster facts into themes, optionally reusing existing themes. */
  cluster(facts: SemanticFact[], existingThemes?: Theme[]): Promise<Theme[]>;
}
