export const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export function slugify(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}\s-]/gu, '').replace(/\s+/g, '-');
}

export function splitTarget(value: string): { linkPath: string; subpath?: string } {
  const hash = value.indexOf('#');
  if (hash < 0) return { linkPath: value.trim() };
  const linkPath = value.slice(0, hash).trim();
  const subpath = value.slice(hash + 1).trim();
  return subpath === '' ? { linkPath } : { linkPath, subpath };
}
