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
import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';
import type { SemanticExtractor, ExtractionResult } from '../interfaces/semantic-extractor.js';

export interface RuleBasedExtractorOptions {
  /** Skip sentences shorter than this (default: 20 chars). */
  minSentenceLength?: number;
  /** Additional entity-detection regexes. */
  entityPatterns?: RegExp[];
  /**
   * Additional relationship verbs. Note: the inflection engine handles
   * regular verbs only. Consonant-doubling verbs (e.g., "stop" → "stopped")
   * are not supported — use pre-inflected forms or the base form.
   */
  relationshipVerbs?: string[];
}

export interface ExtractedEntity {
  name: string;
  type: string;
}

const DEFAULT_RELATIONSHIP_VERBS = [
  'work_at', 'report_to', 'manage', 'lead', 'create',
  'author', 'own', 'use', 'depend_on', 'contain',
  'belong_to', 'collaborate_with', 'review', 'approve',
  'deploy', 'test', 'maintain', 'support', 'block', 'require',
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

  async extract(episode: Episode): Promise<ExtractionResult> {
    const now = new Date();
    const entityNameToId = new Map<string, string>();
    const entityNameToType = new Map<string, string>();
    const seenNormalized = new Set<string>();
    const facts: SemanticFact[] = [];
    const relationships: Relationship[] = [];

    for (const message of episode.messages) {
      const sentences = splitSentences(message.content);

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < this.minSentenceLength) continue;

        const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
        if (seenNormalized.has(normalized)) continue;
        seenNormalized.add(normalized);

        const detectedEntities = this.extractEntities(trimmed);
        const entityIds = detectedEntities.map((e) => {
          if (!entityNameToId.has(e.name)) {
            entityNameToId.set(e.name, crypto.randomUUID());
            entityNameToType.set(e.name, e.type);
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

        // Extract relationships between detected entities in this sentence
        const sentenceRels = this.extractRelationships(
          trimmed, detectedEntities, entityNameToId, episode.started_at, now,
        );
        relationships.push(...sentenceRels);
      }
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

  /**
   * Scan a sentence for verb patterns between known entities.
   * Looks for `<entityA> ... <verb> ... <entityB>` patterns.
   */
  private extractRelationships(
    sentence: string,
    detectedEntities: ExtractedEntity[],
    entityNameToId: Map<string, string>,
    validFrom: Date,
    now: Date,
  ): Relationship[] {
    if (detectedEntities.length < 2) return [];

    const relationships: Relationship[] = [];
    const lowerSentence = sentence.toLowerCase();

    // Find the position of each entity in the sentence using word-boundary matching
    const entityPositions = detectedEntities
      .map((e) => {
        const escaped = e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = sentence.match(new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`));
        return { entity: e, index: match?.index ?? -1 };
      })
      .filter((ep) => ep.index >= 0)
      .sort((a, b) => a.index - b.index);

    // For each adjacent entity pair, look for verb forms between them
    for (let i = 0; i < entityPositions.length - 1; i++) {
      const source = entityPositions[i];
      const target = entityPositions[i + 1];

      const between = lowerSentence.slice(
        source.index + source.entity.name.length,
        target.index,
      );

      for (const [form, canonical] of this.verbFormMap) {
        if (between.includes(form)) {
          const sourceId = entityNameToId.get(source.entity.name);
          const targetId = entityNameToId.get(target.entity.name);
          if (sourceId && targetId) {
            relationships.push({
              id: crypto.randomUUID(),
              source_id: sourceId,
              target_id: targetId,
              relation_type: canonical,
              weight: 1,
              attributes: {},
              valid_from: validFrom,
              provenance: { source: 'derived' as const, created_at: now },
            });
          }
          break; // One relationship per entity pair
        }
      }
    }

    return relationships;
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
