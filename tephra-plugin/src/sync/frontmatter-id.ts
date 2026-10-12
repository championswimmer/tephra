export const FILE_ID_PROPERTY = 'tephra-file-id';

export function extractFrontmatterFileId(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  const prop = new RegExp(`^${FILE_ID_PROPERTY}:\\s*(?:["']?)([^"'\r\n#]+)(?:["']?)`, 'm').exec(
    match[1] ?? '',
  );
  const id = prop?.[1]?.trim();
  return id || undefined;
}

export function injectFrontmatterFileId(content: string, id: string): string {
  const crlf = content.includes('\r\n');
  const newline = crlf ? '\r\n' : '\n';

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (frontmatterMatch) {
    const rawFm = frontmatterMatch[1] ?? '';
    const propRegex = new RegExp(`^${FILE_ID_PROPERTY}:.*$`, 'm');
    if (propRegex.test(rawFm)) {
      const updatedFm = rawFm.replace(propRegex, `${FILE_ID_PROPERTY}: ${id}`);
      return content.replace(rawFm, updatedFm);
    }
  }

  if (content.startsWith('---\r\n')) {
    return `---\r\n${FILE_ID_PROPERTY}: ${id}\r\n${content.slice(5)}`;
  }
  if (content.startsWith('---\n')) {
    return `---\n${FILE_ID_PROPERTY}: ${id}\n${content.slice(4)}`;
  }

  return `---${newline}${FILE_ID_PROPERTY}: ${id}${newline}---${newline}${newline}${content}`;
}

export function stripFrontmatterFileId(content: string): string | undefined {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.))(\r?\n|$)/.exec(content);
  if (!match) return undefined;
  const open = match[1] ?? '';
  const rawFm = match[2] ?? '';
  const close = match[3] ?? '';
  const trailing = match[4] ?? '';
  const newline = content.includes('\r\n') ? '\r\n' : '\n';

  const lines = rawFm.split(/\r?\n/);
  const idx = lines.findIndex((line) =>
    new RegExp(`^${FILE_ID_PROPERTY}\\s*:.*$`).test(line),
  );
  if (idx === -1) return undefined;

  const rest = lines.filter((_, i) => i !== idx);
  if (rest.some((line) => line.trim() !== '')) {
    return `${open}${rest.join(newline)}${close}${trailing}${content.slice(match[0].length)}`;
  }
  // The property was the only key: drop the whole block and one following blank line.
  let body = content.slice(match[0].length);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  return body;
}
