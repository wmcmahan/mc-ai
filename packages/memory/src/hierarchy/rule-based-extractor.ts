/**
 * Rule-Based Multi-Fact Extractor
 *
 * Sentence-level pattern matching to extract atomic facts, entities,
 * and relationships from episodes. Produces multiple facts per episode
 * unlike the simple extractor which produces only one.
 *
 * @module hierarchy/rule-based-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { SemanticExtractor } from '../interfaces/semantic-extractor.js';

export interface RuleBasedExtractorOptions {
  /** Skip sentences shorter than this (default: 20 chars). */
  minSentenceLength?: number;
  /** Additional entity-detection regexes. */
  entityPatterns?: RegExp[];
  /** Additional relationship verbs. */
  relationshipVerbs?: string[];
}

export interface ExtractedEntity {
  name: string;
  type: string;
}

const DEFAULT_RELATIONSHIP_VERBS = [
  'works_at', 'reports_to', 'manages', 'leads', 'created',
  'authored', 'owns', 'uses', 'depends_on', 'contains',
  'belongs_to', 'collaborates_with', 'reviewed', 'approved',
  'deployed', 'tested', 'maintains', 'supports', 'blocks', 'requires',
];

/**
 * Map base verb to inflected forms for regex matching.
 * Returns forms like: work, works, worked, working
 */
function verbForms(verb: string): string[] {
  // verb may be like "works_at" — split on underscore, inflect first word
  const parts = verb.split('_');
  const base = parts[0];
  const rest = parts.slice(1).join(' ');

  const forms: string[] = [];

  // Add the base form and common inflections
  forms.push(base);
  if (base.endsWith('e')) {
    forms.push(base + 's');
    forms.push(base + 'd');
    forms.push(base.slice(0, -1) + 'ing');
  } else if (base.endsWith('y') && !/[aeiou]y$/.test(base)) {
    forms.push(base.slice(0, -1) + 'ies');
    forms.push(base.slice(0, -1) + 'ied');
    forms.push(base + 'ing');
  } else {
    forms.push(base + 's');
    forms.push(base + 'ed');
    forms.push(base + 'ing');
  }

  // Build full forms with the rest of the verb phrase
  if (rest) {
    return forms.map((f) => f + ' ' + rest);
  }
  return forms;
}

const ORG_SUFFIXES = /\b(?:Corp|Inc|Ltd|LLC|Co|Group|Foundation|Institute|Association)\b/i;

export class RuleBasedExtractor implements SemanticExtractor {
  private readonly minSentenceLength: number;
  private readonly extraEntityPatterns: RegExp[];
  private readonly relationshipVerbs: string[];
  private readonly verbFormMap: Map<string, string>;

  constructor(options?: RuleBasedExtractorOptions) {
    this.minSentenceLength = options?.minSentenceLength ?? 20;
    this.extraEntityPatterns = options?.entityPatterns ?? [];
    this.relationshipVerbs = [
      ...DEFAULT_RELATIONSHIP_VERBS,
      ...(options?.relationshipVerbs ?? []),
    ];

    // Pre-build a map from each inflected form to the canonical verb
    this.verbFormMap = new Map();
    for (const verb of this.relationshipVerbs) {
      for (const form of verbForms(verb)) {
        this.verbFormMap.set(form.toLowerCase(), verb);
      }
    }
  }

  async extract(episode: Episode): Promise<SemanticFact[]> {
    const now = new Date();
    const entityNameToId = new Map<string, string>();
    const seenNormalized = new Set<string>();
    const facts: SemanticFact[] = [];

    for (const message of episode.messages) {
      const sentences = splitSentences(message.content);

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < this.minSentenceLength) continue;

        const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
        if (seenNormalized.has(normalized)) continue;
        seenNormalized.add(normalized);

        const entities = this.extractEntities(trimmed);
        const entityIds = entities.map((e) => {
          if (!entityNameToId.has(e.name)) {
            entityNameToId.set(e.name, crypto.randomUUID());
          }
          return entityNameToId.get(e.name)!;
        });

        facts.push({
          id: crypto.randomUUID(),
          content: trimmed,
          source_episode_ids: [episode.id],
          entity_ids: entityIds,
          provenance: {
            source: 'derived',
            created_at: now,
          },
          valid_from: episode.started_at,
        });
      }
    }

    return facts;
  }

  /** Expose entity extraction for reuse by other components. */
  extractEntities(text: string): ExtractedEntity[] {
    const entities = new Map<string, ExtractedEntity>();

    // Capitalized multi-word names: "Alice Smith", "Acme Corp", "Tech LLC"
    const multiWordPattern = /\b[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}))+\b/g;
    for (const match of text.matchAll(multiWordPattern)) {
      const name = match[0];
      const type = ORG_SUFFIXES.test(name) ? 'organization' : 'person';
      entities.set(name, { name, type });
    }

    // Single capitalized words NOT at sentence start
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/[^a-zA-Z]/g, '');
      if (word.length >= 2 && /^[A-Z][a-z]+$/.test(word)) {
        // Skip if already part of a multi-word entity
        const alreadyCovered = [...entities.keys()].some((k) => k.includes(word));
        if (!alreadyCovered) {
          entities.set(word, { name: word, type: 'concept' });
        }
      }
    }

    // @-handles
    const handlePattern = /@\w+/g;
    for (const match of text.matchAll(handlePattern)) {
      entities.set(match[0], { name: match[0], type: 'person' });
    }

    // Quoted terms (double quotes)
    const dblQuotePattern = /"([^"]+)"/g;
    for (const match of text.matchAll(dblQuotePattern)) {
      entities.set(match[1], { name: match[1], type: 'concept' });
    }

    // Quoted terms (single quotes)
    const sglQuotePattern = /'([^']+)'/g;
    for (const match of text.matchAll(sglQuotePattern)) {
      entities.set(match[1], { name: match[1], type: 'concept' });
    }

    // camelCase identifiers
    const camelPattern = /\b[a-z]+[A-Z]\w*/g;
    for (const match of text.matchAll(camelPattern)) {
      entities.set(match[0], { name: match[0], type: 'concept' });
    }

    // ACRONYMS (2+ uppercase letters)
    const acronymPattern = /\b[A-Z]{2,}\b/g;
    for (const match of text.matchAll(acronymPattern)) {
      entities.set(match[0], { name: match[0], type: 'concept' });
    }

    // Additional user-supplied patterns
    for (const pattern of this.extraEntityPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const match of text.matchAll(regex)) {
        const name = match[1] ?? match[0];
        entities.set(name, { name, type: 'concept' });
      }
    }

    return [...entities.values()];
  }
}

/**
 * Split text into sentences, preserving common abbreviations.
 */
function splitSentences(text: string): string[] {
  // Replace common abbreviations to avoid false splits
  const preserved = text
    .replace(/\b(Dr|Mr|Mrs|Ms|Jr|Sr|Prof|e\.g|i\.e|etc|vs|approx)\./gi, '$1\u0000');

  // Split on sentence-ending punctuation followed by whitespace or end
  const raw = preserved.split(/(?<=[.!?])\s+|(?<=[.!?])$/);

  return raw
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length > 0);
}
