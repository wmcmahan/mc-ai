/**
 * Model Capability Profiles
 *
 * Static capability matrix per model family. Used by the format
 * selector to choose the optimal compression format for each model.
 *
 * @module routing/model-profiles
 */

/** Capability profile for a model family. */
export interface ModelProfile {
  /** Model family name (matched via prefix). */
  family: string;
  /** Can the model comprehend TOON/tabular input format? */
  supportsTabular: boolean;
  /** Can the model comprehend YAML-like nested format? */
  supportsNested: boolean;
  /** Does the model work better with JSON for structured data? */
  prefersJson: boolean;
  /** Maximum context window size in tokens. */
  maxContextTokens: number;
  /** Does the model support native prompt caching? */
  supportsCaching: boolean;
  /** Character-to-token ratio. */
  charsPerToken: number;
}

/**
 * Built-in model profiles.
 *
 * Based on TOON benchmark data (arxiv 2601.12014), provider docs,
 * and the existing MODEL_FAMILY_RATIOS in providers/defaults.ts.
 */
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  'gpt-4o': {
    family: 'gpt-4o',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: true,
    charsPerToken: 3.5,
  },
  'gpt-4': {
    family: 'gpt-4',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: true,
    charsPerToken: 3.5,
  },
  'o1': {
    family: 'o1',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 200_000,
    supportsCaching: true,
    charsPerToken: 3.5,
  },
  'o3': {
    family: 'o3',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 200_000,
    supportsCaching: true,
    charsPerToken: 3.5,
  },
  'claude': {
    family: 'claude',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 200_000,
    supportsCaching: true,
    charsPerToken: 3.8,
  },
  'llama': {
    family: 'llama',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
    charsPerToken: 3.6,
  },
  'deepseek': {
    family: 'deepseek',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
    charsPerToken: 3.6,
  },
  'qwen': {
    family: 'qwen',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
    charsPerToken: 3.6,
  },
  'gemini': {
    family: 'gemini',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 1_000_000,
    supportsCaching: true,
    charsPerToken: 3.7,
  },
  'mistral': {
    family: 'mistral',
    supportsTabular: true,
    supportsNested: true,
    prefersJson: false,
    maxContextTokens: 128_000,
    supportsCaching: false,
    charsPerToken: 3.6,
  },
  // Small models that need JSON
  'gemma': {
    family: 'gemma',
    supportsTabular: false,
    supportsNested: true,
    prefersJson: true,
    maxContextTokens: 8_192,
    supportsCaching: false,
    charsPerToken: 3.6,
  },
  'phi': {
    family: 'phi',
    supportsTabular: false,
    supportsNested: true,
    prefersJson: true,
    maxContextTokens: 16_384,
    supportsCaching: false,
    charsPerToken: 3.6,
  },
};

/**
 * Resolve the model profile for a given model string.
 * Matches against known family prefixes (case-insensitive).
 * Returns undefined if no profile matches.
 */
export function resolveModelProfile(model?: string): ModelProfile | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  for (const [prefix, profile] of Object.entries(MODEL_PROFILES)) {
    if (lower.startsWith(prefix)) return profile;
  }
  return undefined;
}
