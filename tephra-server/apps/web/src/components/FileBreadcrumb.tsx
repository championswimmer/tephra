import { useState } from 'react';
import { Check, Copy, Link } from 'lucide-react';
import { fileUrlForPath } from '../vault/path-url';

export function FileBreadcrumb({ vaultName, path }: { vaultName: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const segments = path.split('/').filter((segment) => segment.length > 0);

  async function copyText(text: string, onCopied: (value: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable (permissions, insecure context);
      // fall back to a transient textarea + execCommand copy.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        return;
      }
    }
    onCopied(true);
    window.setTimeout(() => onCopied(false), 1500);
  }

  return (
    <nav className="file-breadcrumb" aria-label="File path">
      <ol className="file-breadcrumb-list">
        <li className="file-breadcrumb-item">
          <span className="file-breadcrumb-vault">{vaultName}</span>
        </li>
        {segments.map((segment, index) => (
          <li key={`${index}-${segment}`} className="file-breadcrumb-item">
            <span aria-hidden="true" className="file-breadcrumb-separator">
              /
            </span>
            {index === segments.length - 1 ? (
              <span aria-current="page" className="file-breadcrumb-current">
                {segment}
              </span>
            ) : (
              <span className="file-breadcrumb-segment">{segment}</span>
            )}
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: '0.4rem', flex: 'none' }}>
        <button
          type="button"
          className="icon-button file-breadcrumb-copy"
          aria-label="Copy file path"
          title="Copy file path"
          onClick={() => void copyText(path, setCopied)}
        >
          {copied ? (
            <Check size={14} aria-hidden="true" focusable="false" className="icon" />
          ) : (
            <Copy size={14} aria-hidden="true" focusable="false" className="icon" />
          )}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy path'}</span>
        </button>
        <button
          type="button"
          className="icon-button file-breadcrumb-copy"
          aria-label="Copy file URL"
          title="Copy file URL"
          onClick={() => void copyText(fileUrlForPath(window.location.href, path), setUrlCopied)}
        >
          {urlCopied ? (
            <Check size={14} aria-hidden="true" focusable="false" className="icon" />
          ) : (
            <Link size={14} aria-hidden="true" focusable="false" className="icon" />
          )}
          <span aria-live="polite">{urlCopied ? 'Copied' : 'Copy URL'}</span>
        </button>
      </div>
    </nav>
  );
}
