import type { VaultFile } from '../api/types';
import { Download } from 'lucide-react';
import { api } from '../api/client';
export function AttachmentViewer({ vaultId, file }: { vaultId: string; file: VaultFile }) {
  const url = api.contentUrl(vaultId, file.fileId);
  const mime = file.mimeType ?? '';
  const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime);
  const pdf = mime === 'application/pdf' || file.path.toLowerCase().endsWith('.pdf');
  return (
    <div className="attachment-view">
      <header className="note-toolbar">
        <div>
          <p className="eyebrow">Attachment</p>
          <h2>{file.path.split('/').pop()}</h2>
        </div>
        <a className="button icon-button" href={url} download>
          <Download size={14} aria-hidden="true" focusable="false" className="icon" />
          Download
        </a>
      </header>
      {image ? (
        <img src={url} alt={file.path.split('/').pop() ?? 'Attachment'} />
      ) : pdf ? (
        <object data={url} type="application/pdf">
          <p>
            PDF preview unavailable. <a href={url}>Download the PDF</a>.
          </p>
        </object>
      ) : (
        <div className="status empty">
          <strong>Preview unavailable</strong>
          <p>This file type is offered as a safe download.</p>
        </div>
      )}
    </div>
  );
}
