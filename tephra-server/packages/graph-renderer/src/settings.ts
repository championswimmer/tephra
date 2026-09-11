/**
 * Graph settings: the Obsidian Filters / Groups / Display / Forces model,
 * persisted per vault per scope in localStorage. Pure module — injectable
 * storage keeps it testable under vitest.
 */

export interface ColorGroup {
  query: string;
  color: string;
}

export interface GraphSettings {
  // Filters
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  existingOnly: boolean;
  showOrphans: boolean;
  // Groups (first match wins)
  groups: ColorGroup[];
  // Display
  showArrows: boolean;
  /** Zoom scale at which labels reach full opacity; 0 hides labels. */
  textFadeThreshold: number;
  /** Multiplier for node radius. */
  nodeSize: number;
  /** Multiplier for link width. */
  linkThickness: number;
  // Forces (slider values; mapped onto the ForceAtlas2 layout settings)
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  /** Local graph only: neighbourhood depth in hops. */
  depth: number;
}

export type GraphScope = 'global' | 'local';

/** Obsidian's defaults: tags/attachments off, everything else visible. */
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  search: '',
  showTags: false,
  showAttachments: false,
  existingOnly: false,
  showOrphans: true,
  groups: [],
  showArrows: false,
  textFadeThreshold: 0.3,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.5,
  repelForce: 1,
  linkForce: 0.5,
  linkDistance: 100,
  depth: 1,
};

/** Slider ranges enforced by both the panel UI and settings sanitization. */
export const SETTINGS_LIMITS = {
  textFadeThreshold: { min: 0, max: 1 },
  nodeSize: { min: 0.25, max: 4 },
  linkThickness: { min: 0.25, max: 4 },
  centerForce: { min: 0, max: 1 },
  repelForce: { min: 0, max: 2 },
  linkForce: { min: 0, max: 1 },
  linkDistance: { min: 30, max: 300 },
  depth: { min: 1, max: 6 },
} as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Merge unknown stored data onto the defaults, clamping every numeric field. */
export function sanitizeGraphSettings(raw: unknown): GraphSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const defaults = DEFAULT_GRAPH_SETTINGS;
  const groups = Array.isArray(source.groups)
    ? source.groups
        .filter(
          (group): group is { query: string; color: string } =>
            typeof group === 'object' &&
            group !== null &&
            typeof (group as Record<string, unknown>).query === 'string' &&
            typeof (group as Record<string, unknown>).color === 'string' &&
            HEX_COLOR.test((group as { color: string }).color),
        )
        .slice(0, 20)
    : defaults.groups;
  return {
    search: typeof source.search === 'string' ? source.search : defaults.search,
    showTags: clampBoolean(source.showTags, defaults.showTags),
    showAttachments: clampBoolean(source.showAttachments, defaults.showAttachments),
    existingOnly: clampBoolean(source.existingOnly, defaults.existingOnly),
    showOrphans: clampBoolean(source.showOrphans, defaults.showOrphans),
    groups,
    showArrows: clampBoolean(source.showArrows, defaults.showArrows),
    textFadeThreshold: clampNumber(
      source.textFadeThreshold,
      defaults.textFadeThreshold,
      SETTINGS_LIMITS.textFadeThreshold.min,
      SETTINGS_LIMITS.textFadeThreshold.max,
    ),
    nodeSize: clampNumber(
      source.nodeSize,
      defaults.nodeSize,
      SETTINGS_LIMITS.nodeSize.min,
      SETTINGS_LIMITS.nodeSize.max,
    ),
    linkThickness: clampNumber(
      source.linkThickness,
      defaults.linkThickness,
      SETTINGS_LIMITS.linkThickness.min,
      SETTINGS_LIMITS.linkThickness.max,
    ),
    centerForce: clampNumber(
      source.centerForce,
      defaults.centerForce,
      SETTINGS_LIMITS.centerForce.min,
      SETTINGS_LIMITS.centerForce.max,
    ),
    repelForce: clampNumber(
      source.repelForce,
      defaults.repelForce,
      SETTINGS_LIMITS.repelForce.min,
      SETTINGS_LIMITS.repelForce.max,
    ),
    linkForce: clampNumber(
      source.linkForce,
      defaults.linkForce,
      SETTINGS_LIMITS.linkForce.min,
      SETTINGS_LIMITS.linkForce.max,
    ),
    linkDistance: clampNumber(
      source.linkDistance,
      defaults.linkDistance,
      SETTINGS_LIMITS.linkDistance.min,
      SETTINGS_LIMITS.linkDistance.max,
    ),
    depth: Math.round(
      clampNumber(
        source.depth,
        defaults.depth,
        SETTINGS_LIMITS.depth.min,
        SETTINGS_LIMITS.depth.max,
      ),
    ),
  };
}

export function graphSettingsKey(vaultId: string, scope: GraphScope): string {
  return `tephra:graph:${vaultId}:${scope}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Load settings for a vault/scope, falling back to (and sanitizing to) defaults. */
export function loadGraphSettings(
  vaultId: string,
  scope: GraphScope,
  storage: StorageLike | null = defaultStorage(),
): GraphSettings {
  try {
    const raw = storage?.getItem(graphSettingsKey(vaultId, scope));
    return sanitizeGraphSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

export function saveGraphSettings(
  vaultId: string,
  scope: GraphScope,
  settings: GraphSettings,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(
      graphSettingsKey(vaultId, scope),
      JSON.stringify(sanitizeGraphSettings(settings)),
    );
  } catch {
    // Storage may be unavailable (private mode); settings simply don't persist.
  }
}

export function restoreDefaultGraphSettings(
  vaultId: string,
  scope: GraphScope,
  storage: StorageLike | null = defaultStorage(),
): GraphSettings {
  try {
    storage?.removeItem(graphSettingsKey(vaultId, scope));
  } catch {
    // Ignore storage failures; defaults are returned regardless.
  }
  return { ...DEFAULT_GRAPH_SETTINGS };
}
