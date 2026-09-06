/**
 * Obsidian default theme definitions.
 *
 * Obsidian ships a single built-in "Default" theme with two base color
 * schemes (light / dark). Additional looks come from community themes, which
 * are out of scope for Stage 1 (read-only mirror). The values below mirror
 * Obsidian's bundled `app.css` for `.theme-light` / `.theme-dark` so the web
 * vault and the website match the default Obsidian appearance.
 */
export type ThemeId = 'obsidian-light' | 'obsidian-dark';
export type ThemeBase = 'light' | 'dark' | 'system';

export interface ObsidianThemeDefinition {
  id: ThemeId;
  /** Display name shown in the theme selector. */
  label: string;
  /** Resolved base color scheme (never 'system'). */
  scheme: 'light' | 'dark';
  /** Hex used for `<meta name="theme-color">`. */
  themeColor: string;
  /** Obsidian CSS variables applied to `:root` / `html`. */
  variables: Record<string, string>;
}

export const DEFAULT_LIGHT_VARIABLES: Record<string, string> = {
  '--background-primary': '#ffffff',
  '--background-primary-alt': '#f5f6f8',
  '--background-secondary': '#f2f3f5',
  '--background-secondary-alt': '#e8eaed',
  '--background-modifier-border': '#e0e0e0',
  '--background-modifier-border-focus': '#c8c8c8',
  '--background-modifier-form-field': '#ffffff',
  '--background-modifier-hover': 'rgba(0, 0, 0, 0.05)',
  '--background-modifier-active-hover': 'rgba(0, 0, 0, 0.08)',
  '--text-normal': '#2e3338',
  '--text-muted': '#71747b',
  '--text-faint': '#a3a6ad',
  '--text-accent': '#7b6cd9',
  '--text-accent-hover': '#8f7ee6',
  '--text-on-accent': '#ffffff',
  '--interactive-normal': '#f2f3f5',
  '--interactive-hover': '#e8eaed',
  '--interactive-accent': '#7b6cd9',
  '--interactive-accent-hover': '#8f7ee6',
  '--code-background': '#f2f3f5',
  '--code-normal': '#2e3338',
  '--graph-node': '#000000',
  '--graph-line': '#d1d1d1',
  '--graph-node-tag': '#7f6df2',
  '--graph-node-attachment': '#d669bc',
  '--graph-node-unresolved': '#999999',
  '--graph-node-focused': '#ff0000',
};

export const DEFAULT_DARK_VARIABLES: Record<string, string> = {
  '--background-primary': '#202020',
  '--background-primary-alt': '#1a1a1a',
  '--background-secondary': '#161616',
  '--background-secondary-alt': '#0e0e0e',
  '--background-modifier-border': '#333333',
  '--background-modifier-border-focus': '#4a4a4a',
  '--background-modifier-form-field': '#1a1a1a',
  '--background-modifier-hover': 'rgba(255, 255, 255, 0.06)',
  '--background-modifier-active-hover': 'rgba(255, 255, 255, 0.1)',
  '--text-normal': '#dcddde',
  '--text-muted': '#999999',
  '--text-faint': '#666666',
  '--text-accent': '#8f7ee6',
  '--text-accent-hover': '#a294f0',
  '--text-on-accent': '#ffffff',
  '--interactive-normal': '#2a2a2a',
  '--interactive-hover': '#333333',
  '--interactive-accent': '#7b6cd9',
  '--interactive-accent-hover': '#8f7ee6',
  '--code-background': '#161616',
  '--code-normal': '#dcddde',
  '--graph-node': '#5dbcd2',
  '--graph-line': '#4b4b4b',
  '--graph-node-tag': '#5dbcd2',
  '--graph-node-attachment': '#d669bc',
  '--graph-node-unresolved': '#9e8aff',
  '--graph-node-focused': '#ff0000',
};

export const OBSIDIAN_THEMES: ObsidianThemeDefinition[] = [
  {
    id: 'obsidian-light',
    label: 'Default (Light)',
    scheme: 'light',
    themeColor: '#ffffff',
    variables: DEFAULT_LIGHT_VARIABLES,
  },
  {
    id: 'obsidian-dark',
    label: 'Default (Dark)',
    scheme: 'dark',
    themeColor: '#202020',
    variables: DEFAULT_DARK_VARIABLES,
  },
];

export const OBSIDIAN_THEME_IDS = OBSIDIAN_THEMES.map((t) => t.id);

export function getThemeById(id: string): ObsidianThemeDefinition {
  const found = OBSIDIAN_THEMES.find((t) => t.id === id);
  if (found) return found;
  const fallback = OBSIDIAN_THEMES[0];
  if (!fallback) throw new Error('No Obsidian themes defined.');
  return fallback;
}

/** Resolve a base setting ('light' | 'dark' | 'system') to a concrete theme. */
export function resolveBaseScheme(
  base: ThemeBase,
  prefersDark: boolean,
): ObsidianThemeDefinition {
  if (base === 'dark' || (base === 'system' && prefersDark)) {
    return getThemeById('obsidian-dark');
  }
  return getThemeById('obsidian-light');
}
