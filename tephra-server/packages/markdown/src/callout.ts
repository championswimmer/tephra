import { escapeHtml } from './text.js';

/** Obsidian callout type aliases map to their canonical type. */
const CALLOUT_ALIASES: Record<string, string> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  important: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  caution: 'warning',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

const CALLOUT_TYPES = new Set([
  'note', 'abstract', 'info', 'todo', 'tip', 'success',
  'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote',
]);

const svgIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Minimal stroke icons (one per canonical callout type). Decorative only. */
const CALLOUT_ICONS: Record<string, string> = {
  note: svgIcon('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
  abstract: svgIcon('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  todo: svgIcon('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/>'),
  tip: svgIcon('<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>'),
  success: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
  question: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  warning: svgIcon('<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>'),
  failure: svgIcon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>'),
  danger: svgIcon('<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>'),
  bug: svgIcon('<path d="m8 2 1.5 2.5M16 2l-1.5 2.5M12 4v3"/><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M4 10h3M4 15h3M20 10h-3M20 15h-3"/>'),
  example: svgIcon('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
  quote: svgIcon('<path d="M10 7H6a2 2 0 0 0-2 2v7h7v-7H6.5A1.5 1.5 0 0 1 8 7.5V7h2Z"/><path d="M20 7h-4a2 2 0 0 0-2 2v7h7v-7h-4.5A1.5 1.5 0 0 1 18 7.5V7h2Z"/>'),
};


export interface CalloutRenderers {
  inline: (value: string) => string;
  blocks: (lines: string[]) => string[];
}

/**
 * Render an Obsidian callout (`> [!type] title`). The head match covers the
 * first quote line; bodyLines are the remaining stripped quote lines.
 * Unknown types fall back to `note` styling, like Obsidian.
 */
export function renderCallout(head: RegExpExecArray, bodyLines: string[], render: CalloutRenderers): string {
  const rawType = (head[1] ?? 'note').toLowerCase();
  const foldMarker = head[2] ?? '';
  const customTitle = (head[3] ?? '').trim();
  const canonical = CALLOUT_ALIASES[rawType] ?? rawType;
  const colorType = CALLOUT_TYPES.has(canonical) ? canonical : 'note';
  const title = customTitle !== ''
    ? customTitle
    : rawType.charAt(0).toUpperCase() + rawType.slice(1);
  const icon = CALLOUT_ICONS[colorType] ?? CALLOUT_ICONS.note ?? '';
  const titleInner = `<div class="callout-icon">${icon}</div><div class="callout-title-inner">${render.inline(title)}</div>`;
  const bodyHtml = render.blocks(bodyLines).join('\n').trim();
  const content = bodyHtml === '' ? '' : `\n<div class="callout-content">\n${bodyHtml}\n</div>`;
  const attrs = `class="callout" data-callout="${escapeHtml(rawType)}"`;
  if (foldMarker !== '') {
    const open = foldMarker === '+' ? ' open' : '';
    return `<details ${attrs}${open}>\n<summary class="callout-title">${titleInner}</summary>${content}\n</details>`;
  }
  return `<div ${attrs}>\n<div class="callout-title">${titleInner}</div>${content}\n</div>`;
}
