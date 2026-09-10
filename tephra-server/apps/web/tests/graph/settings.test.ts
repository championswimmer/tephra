import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRAPH_SETTINGS,
  loadGraphSettings,
  restoreDefaultGraphSettings,
  sanitizeGraphSettings,
  saveGraphSettings,
} from '../../src/graph/settings';

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

describe('sanitizeGraphSettings', () => {
  it('defaults everything on garbage input', () => {
    expect(sanitizeGraphSettings(null)).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(sanitizeGraphSettings('nope')).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(sanitizeGraphSettings({ nodeSize: 'huge', showTags: 'yes' })).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it('keeps valid values and clamps numeric ranges', () => {
    const settings = sanitizeGraphSettings({
      search: 'tag:#x',
      showTags: true,
      nodeSize: 99,
      linkDistance: -5,
      textFadeThreshold: 0.6,
      depth: 4.6,
      groups: [
        { query: 'tag:#x', color: '#ff8800' },
        { query: 'broken', color: 'not-a-color' },
        'not-an-object',
      ],
    });
    expect(settings.search).toBe('tag:#x');
    expect(settings.showTags).toBe(true);
    expect(settings.nodeSize).toBe(4);
    expect(settings.linkDistance).toBe(30);
    expect(settings.textFadeThreshold).toBe(0.6);
    expect(settings.depth).toBe(5);
    expect(settings.groups).toEqual([{ query: 'tag:#x', color: '#ff8800' }]);
  });
});

describe('graph settings persistence', () => {
  it('round-trips through storage keyed per vault and scope', () => {
    const storage = memoryStorage();
    saveGraphSettings('vault-1', 'global', { ...DEFAULT_GRAPH_SETTINGS, showTags: true }, storage);
    expect(loadGraphSettings('vault-1', 'global', storage).showTags).toBe(true);
    expect(loadGraphSettings('vault-2', 'global', storage).showTags).toBe(false);
    expect(loadGraphSettings('vault-1', 'local', storage).showTags).toBe(false);
  });

  it('falls back to defaults on corrupt stored JSON', () => {
    const storage = memoryStorage({ 'tephra:graph:vault-1:global': '{broken' });
    expect(loadGraphSettings('vault-1', 'global', storage)).toEqual(DEFAULT_GRAPH_SETTINGS);
  });

  it('restoreDefaults clears storage and returns defaults', () => {
    const storage = memoryStorage();
    saveGraphSettings('vault-1', 'global', { ...DEFAULT_GRAPH_SETTINGS, search: 'x' }, storage);
    expect(restoreDefaultGraphSettings('vault-1', 'global', storage)).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(loadGraphSettings('vault-1', 'global', storage)).toEqual(DEFAULT_GRAPH_SETTINGS);
  });
});
