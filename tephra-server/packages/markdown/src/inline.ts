import { resolveLink as resolveVaultLink } from '@tephra/link-resolver';
import { escapeHtml, splitTarget } from './text.js';
import type { MarkdownRenderOptions, RenderTarget } from './types.js';

function safeHref(value: string): string | null {
  const decodedEntities = value.replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_match, hex: string | undefined, decimal: string | undefined) =>
    String.fromCodePoint(Number.parseInt(hex ?? decimal ?? '0', hex === undefined ? 10 : 16)));
  const compact = [...decodedEntities]
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x20)
    .join('')
    .toLocaleLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')) return null;
  return value;
}

function resolveForRender(options: MarkdownRenderOptions, target: string): RenderTarget | undefined {
  if (options.resolveLink) return options.resolveLink(options.sourcePath, target);
  if (options.vaultIndex) return resolveVaultLink(options.sourcePath, target, options.vaultIndex);
  return undefined;
}

export function renderInline(value: string, options: MarkdownRenderOptions): string {
  const tokens: string[] = [];
  const store = (html: string): string => `\uE000${String(tokens.push(html) - 1)}\uE001`;
  let output = value.replace(/(`+)([^`]*?)\1/g, (_raw, _ticks: string, codeValue: string) => store(`<code>${escapeHtml(codeValue)}</code>`));
  output = output.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (_raw, bang: string, innerValue: string) => {
    const parts = innerValue.split('|');
    const target = splitTarget(parts[0] ?? '');
    const display = parts.slice(1).join('|') || target.subpath || target.linkPath;
    const resolved = resolveForRender(options, `${target.linkPath}${target.subpath ? `#${target.subpath}` : ''}`);
    const attrs = `data-link-path="${escapeHtml(target.linkPath)}"${target.subpath ? ` data-subpath="${escapeHtml(target.subpath)}"` : ''}`;
    if (bang === '!' && resolved?.targetFileId && (resolved.targetKind ?? resolved.kind) === 'attachment' && options.attachmentUrl) {
      const src = safeHref(options.attachmentUrl(resolved.targetFileId));
      return src === null ? store(`<span class="tephra-unresolved" ${attrs}>${escapeHtml(display)}</span>`) : store(`<img src="${escapeHtml(src)}" alt="${escapeHtml(display)}" ${attrs}>`);
    }
    const state = resolved?.ambiguous ? 'tephra-ambiguous' : resolved?.unresolved ? 'tephra-unresolved' : 'tephra-link';
    const embed = bang === '!' ? ' data-embed="true"' : '';
    const fileAttr = resolved?.targetFileId ? ` data-file-id="${escapeHtml(resolved.targetFileId)}"` : '';
    const missingAttr = resolved && !resolved.targetFileId && resolved.unresolved ? ` data-unresolved-target="${escapeHtml(target.linkPath)}"` : '';
    return store(`<a href="#" class="${state}" ${attrs}${fileAttr}${missingAttr}${embed}>${escapeHtml(display)}</a>`);
  });
  output = output.replace(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_raw, bang: string, label: string, destinationValue: string) => {
    const destination = destinationValue.trim().replace(/^<|>$/g, '');
    const href = safeHref(destination);
    if (href === null) return store(`<span class="tephra-unsafe-link">${escapeHtml(label)}</span>`);
    const external = /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//');
    if (!external) {
      const target = splitTarget(destination);
      const resolved = resolveForRender(options, destination);
      const state = resolved?.ambiguous ? 'tephra-ambiguous' : resolved?.unresolved ? 'tephra-unresolved' : 'tephra-link';
      const fileAttr = resolved?.targetFileId ? ` data-file-id="${escapeHtml(resolved.targetFileId)}"` : '';
      const missingAttr = resolved && !resolved.targetFileId && resolved.unresolved ? ` data-unresolved-target="${escapeHtml(target.linkPath)}"` : '';
      return store(`<a href="#" class="${state}" data-link-path="${escapeHtml(target.linkPath)}"${target.subpath ? ` data-subpath="${escapeHtml(target.subpath)}"` : ''}${fileAttr}${missingAttr}>${escapeHtml(label)}</a>`);
    }
    if (bang === '!') return store(`<img src="${escapeHtml(href)}" alt="${escapeHtml(label)}">`);
    return store(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return output.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => tokens[Number(index)] ?? '');
}

