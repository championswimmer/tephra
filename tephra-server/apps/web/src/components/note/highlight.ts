import { highlight } from 'sugar-high';
import { lang } from 'sugar-high/lang';

/** Blocks larger than this stay plain text so huge pastes never block the UI. */
const MAX_HIGHLIGHT_CHARS = 50_000;

type Language = NonNullable<NonNullable<Parameters<typeof highlight>[1]>['lang']>;

/**
 * Highlight every fenced code block (`<pre><code>`) in a parsed note.
 *
 * The server renders fences without language information, so the default
 * (JS-flavoured, but broadly C-like/generic) tokenizer is used unless the
 * `<code>` carries a `language-*` class. sugar-high escapes all text, and
 * the original text is preserved verbatim when highlighting is skipped.
 * Token colors come from the `--sh-*` theme variables.
 */
export function highlightCodeBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
    const text = code.textContent ?? '';
    if (text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS) return;
    const hint = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(code.className)?.[1];
    const language = hint ? (lang(hint) as Language | undefined) : undefined;
    try {
      code.innerHTML = highlight(text, language ? { lang: language } : undefined);
      code.classList.add('tephra-highlighted');
    } catch {
      code.textContent = text;
    }
  });
}
