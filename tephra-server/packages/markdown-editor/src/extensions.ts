/**
 * CodeMirror extension factories: markdown language support (with GFM),
 * the light/dark theme, and the Cmd/Ctrl+S save binding.
 *
 * The editor never renders untrusted HTML — content stays a plain-text
 * markdown document; rendering happens elsewhere through the server
 * renderer plus sanitization.
 */

import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

export type TephraTheme = 'light' | 'dark';

/** Markdown language support with GitHub-Flavored Markdown extensions. */
export function markdownSupport(): Extension {
  return markdown({ extensions: GFM });
}

/**
 * Editor theme bound to a `light | dark` prop. Keeps to structural styling
 * (font, layout) plus a caret/selection treatment per mode; the app's own
 * stylesheet owns the surrounding chrome.
 */
export function tephraTheme(theme: TephraTheme): Extension {
  const dark = theme === 'dark';
  return [
    EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: '14px',
        },
        '.cm-content': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          lineHeight: '1.6',
        },
        '.cm-scroller': {
          overflow: 'auto',
        },
        '&.cm-focused': {
          outline: 'none',
        },
      },
      { dark },
    ),
    syntaxHighlighting(defaultHighlightStyle),
  ];
}

/** High-precedence Cmd/Ctrl+S binding that routes into `onSave`. */
export function saveKeyBinding(onSave: () => void): Extension {
  return keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSave();
        return true;
      },
    },
  ]);
}
