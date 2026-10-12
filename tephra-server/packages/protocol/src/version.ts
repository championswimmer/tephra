export const PROTOCOL_VERSION = '2';
export const MINIMUM_PLUGIN_VERSION = '0.2.0';
export const PROTOCOL_VERSION_HEADER = 'X-Tephra-Protocol-Version';
export const PLUGIN_VERSION_HEADER = 'X-Tephra-Plugin-Version';

function parseVersionTuple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedPluginVersion(version: string | null | undefined): boolean {
  if (version === null || version === undefined || version.trim() === '') return true;
  const actual = parseVersionTuple(version);
  const minimum = parseVersionTuple(MINIMUM_PLUGIN_VERSION);
  if (actual === null || minimum === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}
