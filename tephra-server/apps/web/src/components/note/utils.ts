import type { ConflictOutcome } from '@tephra/markdown-editor';
import type { EditConflictCurrent } from '../../api/types';

/** Markdown files larger than this open read-only; the editor stays off. */
export const MAX_EDIT_BYTES = 1024 * 1024;

export type Mode = 'rendered' | 'source' | 'edit';

export interface ConflictState {
  /** Server state from the 409 response. */
  current: EditConflictCurrent;
  /** Fresh server bytes fetched after the conflict. */
  serverText: string;
  /** Local text that was rejected. */
  localText: string;
  /** Suggestion from `resolveConflict`; null when it could not be computed. */
  outcome: ConflictOutcome | null;
}

export function containServerHtml(html: string): string {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  documentNode
    .querySelectorAll('script, iframe, object, embed, form, base, meta')
    .forEach((node) => node.remove());
  documentNode.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
      if (
        (attribute.name === 'href' || attribute.name === 'src') &&
        /^\s*javascript:/i.test(attribute.value)
      )
        element.removeAttribute(attribute.name);
    }
  });
  return documentNode.body.innerHTML;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function conflictCopyName(path: string, now: Date = new Date()): string {
  const stem = path.split('/').pop() ?? 'note';
  const base = stem.toLowerCase().endsWith('.md') ? stem.slice(0, -3) : stem;
  const day = now.toISOString().slice(0, 10);
  return `${base} (web conflicted copy, ${day}).md`;
}

/** Offer `text` to the user as a downloaded markdown file. */
export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
