import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function FileBreadcrumb({ vaultName, path }: { vaultName: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const segments = path.split('/').filter((segment) => segment.length > 0);

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // Clipboard may be unavailable (permissions, insecure context);
      // fall back to a transient textarea + execCommand copy.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = path;
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
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
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
      <button
        type="button"
        className="icon-button file-breadcrumb-copy"
        aria-label="Copy file path"
        title="Copy file path"
        onClick={() => void copyPath()}
      >
        {copied ? (
          <Check size={14} aria-hidden="true" focusable="false" className="icon" />
        ) : (
          <Copy size={14} aria-hidden="true" focusable="false" className="icon" />
        )}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy path'}</span>
      </button>
    </nav>
  );
}
