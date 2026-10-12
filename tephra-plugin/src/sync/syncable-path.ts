const TEMP_SUFFIXES = ['~', '.tmp', '.temp', '.swp', '.swo', '.part'];

export function shouldSyncPath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  const name = segments.at(-1)?.toLowerCase() ?? '';
  return !name.startsWith('~$') && !TEMP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
