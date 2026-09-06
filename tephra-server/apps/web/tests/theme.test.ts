import { describe, expect, it } from 'vitest';
import { getThemeById, resolveBaseScheme } from '../src/theme/themes';

describe('Obsidian default themes', () => {
  it('resolves the light default theme', () => {
    const theme = getThemeById('obsidian-light');
    expect(theme.scheme).toBe('light');
    expect(theme.variables['--background-primary']).toBe('#ffffff');
    expect(theme.variables['--text-normal']).toBe('#2e3338');
  });

  it('resolves the dark default theme', () => {
    const theme = getThemeById('obsidian-dark');
    expect(theme.scheme).toBe('dark');
    expect(theme.variables['--background-primary']).toBe('#202020');
    expect(theme.variables['--text-normal']).toBe('#dcddde');
  });

  it('falls back to the light default for unknown ids', () => {
    expect(getThemeById('nonexistent').id).toBe('obsidian-light');
  });

  it('uses one shared accent across both schemes', () => {
    expect(getThemeById('obsidian-light').variables['--interactive-accent']).toBe(
      getThemeById('obsidian-dark').variables['--interactive-accent'],
    );
  });

  it('follows the OS preference when base is system', () => {
    expect(resolveBaseScheme('system', false).id).toBe('obsidian-light');
    expect(resolveBaseScheme('system', true).id).toBe('obsidian-dark');
  });

  it('honours explicit light/dark choices regardless of OS', () => {
    expect(resolveBaseScheme('light', true).id).toBe('obsidian-light');
    expect(resolveBaseScheme('dark', false).id).toBe('obsidian-dark');
  });
});
