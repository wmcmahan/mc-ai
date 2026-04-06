import { describe, it, expect } from 'vitest';
import { formatHierarchy, createHierarchyFormatterStage } from '../src/memory/hierarchy/hierarchy-formatter.js';
import { THEMES, FACTS, EPISODES, FULL_MEMORY_PAYLOAD } from './fixtures/memory-hierarchy.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

describe('formatHierarchy', () => {
  it('groups facts under themes', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);
    expect(result).toContain('System Architecture');
    expect(result).toContain('graph-based workflow engine');
    expect(result).toContain('Team & People');
    expect(result).toContain('Alice is the lead engineer');
  });

  it('shows facts with date annotations', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);
    expect(result).toContain('2026-01-15');
    expect(result).toContain('2026-03-01');
  });

  it('includes orphan facts under Ungrouped', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);
    expect(result).toContain('Ungrouped Facts');
    expect(result).toContain('CI pipeline runs in under 3 minutes');
  });

  it('includes episode summaries', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);
    expect(result).toContain('Recent Episodes');
    expect(result).toContain('Architecture design review');
    expect(result).toContain('4 msgs');
    expect(result).toContain('2 facts');
  });

  it('orders episodes by recency (most recent first)', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);
    const costIdx = result.indexOf('Cost optimization research');
    const archIdx = result.indexOf('Architecture design review');
    expect(costIdx).toBeLessThan(archIdx);
  });

  it('does not include full messages by default', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);
    expect(result).not.toContain('[user]');
    expect(result).not.toContain('[assistant]');
  });

  it('includes full messages when option is set', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD, { includeMessages: true });
    expect(result).toContain('[user]');
    expect(result).toContain('[assistant]');
  });

  it('respects maxEpisodes option', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD, { maxEpisodes: 2 });
    // Only 2 most recent episodes
    const episodeSection = result.slice(result.indexOf('Recent Episodes'));
    const matches = episodeSection.match(/^\s{2}- /gm);
    expect(matches?.length).toBeLessThanOrEqual(2);
  });

  it('skips empty themes by default', () => {
    const payload = {
      themes: [{ id: 'empty', label: 'Empty Theme', description: 'No facts', fact_ids: ['nonexistent'] }],
      facts: [],
    };
    const result = formatHierarchy(payload);
    expect(result).not.toContain('Empty Theme');
  });

  it('shows empty themes when skipEmptyThemes is false', () => {
    const payload = {
      themes: [{ id: 'empty', label: 'Empty Theme', description: 'No facts', fact_ids: ['nonexistent'] }],
      facts: [],
    };
    const result = formatHierarchy(payload, { skipEmptyThemes: false });
    expect(result).toContain('Empty Theme');
  });

  it('handles empty payload gracefully', () => {
    const result = formatHierarchy({});
    expect(result).toBe('');
  });

  it('produces significantly fewer tokens than JSON.stringify', () => {
    const json = JSON.stringify(FULL_MEMORY_PAYLOAD, null, 2);
    const formatted = formatHierarchy(FULL_MEMORY_PAYLOAD);

    const jsonTokens = counter.countTokens(json);
    const formattedTokens = counter.countTokens(formatted);
    const reduction = ((jsonTokens - formattedTokens) / jsonTokens) * 100;

    expect(reduction).toBeGreaterThanOrEqual(40);
  });
});

describe('createHierarchyFormatterStage', () => {
  it('formats segments with contentType hierarchy', () => {
    const stage = createHierarchyFormatterStage();
    const content = JSON.stringify(FULL_MEMORY_PAYLOAD);
    const segments: PromptSegment[] = [{
      id: 'mem', content, role: 'memory', priority: 1, locked: false,
      metadata: { contentType: 'hierarchy' },
    }];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('Themes:');
    expect(result.segments[0].content).not.toContain('"themes"'); // not JSON
  });

  it('passes through segments without hierarchy contentType', () => {
    const stage = createHierarchyFormatterStage();
    const segments: PromptSegment[] = [{
      id: 'other', content: 'plain text', role: 'memory', priority: 1, locked: false,
    }];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('plain text');
  });

  it('has name hierarchy-formatter', () => {
    const stage = createHierarchyFormatterStage();
    expect(stage.name).toBe('hierarchy-formatter');
  });
});
