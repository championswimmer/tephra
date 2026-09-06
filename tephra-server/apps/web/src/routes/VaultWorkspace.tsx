import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { LinksResponse, Vault, VaultFile } from '../api/types';
import { AttachmentViewer } from '../components/AttachmentViewer';
import { FileTree } from '../components/FileTree';
import { GraphView } from '../components/GraphView';
import { LinksPanel } from '../components/LinksPanel';
import { NoteViewer } from '../components/NoteViewer';
import { EmptyState, ErrorState, IndexPending, Loading } from '../components/Status';
import { TokenManager } from '../components/TokenManager';

type View = { type: 'home' | 'graph' | 'tokens' | 'file'; fileId?: string };
function parseView(rest?: string): View {
  if (!rest) return { type: 'home' };
  if (rest === 'graph') return { type: 'graph' };
  if (rest === 'tokens') return { type: 'tokens' };
  if (rest.startsWith('file/')) return { type: 'file', fileId: decodeURIComponent(rest.slice(5)) };
  return { type: 'home' };
}
export function VaultWorkspace() {
  const { vaultId = '', '*': rest } = useParams();
  const navigate = useNavigate();
  const view = parseView(rest);
  const [vault, setVault] = useState<Vault>();
  const [files, setFiles] = useState<VaultFile[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [links, setLinks] = useState<LinksResponse>();
  const [treeOpen, setTreeOpen] = useState(false);
  async function load() {
    setError(undefined);
    try {
      const [vaultResult, fileResult] = await Promise.all([api.vault(vaultId), api.files(vaultId)]);
      setVault(vaultResult.vault);
      setFiles(fileResult.files);
      setPending(Boolean(fileResult.indexPending));
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [vaultId]);
  useEffect(() => {
    setLinks(undefined);
    if (view.type === 'file' && view.fileId)
      void api
        .links(vaultId, view.fileId)
        .then(setLinks)
        .catch(() => setLinks({ links: [], backlinks: [] }));
  }, [vaultId, view.type, view.fileId]);
  const selected = useMemo(
    () => files?.find((file) => file.fileId === view.fileId),
    [files, view.fileId],
  );
  const open = (id: string) => {
    navigate(`/v/${vaultId}/file/${encodeURIComponent(id)}`);
    setTreeOpen(false);
  };
  if (error)
    return (
      <main className="page">
        <ErrorState error={error} retry={() => void load()} />
      </main>
    );
  if (!files || !vault)
    return (
      <main>
        <Loading label="Opening vault…" />
      </main>
    );
  return (
    <main className="workspace">
      <header className="vault-header">
        <div>
          <button
            className="mobile-tree-button"
            type="button"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen(!treeOpen)}
          >
            ☰ Files
          </button>
          <Link to="/vaults">Vaults</Link>
          <span aria-hidden="true">/</span>
          <strong>{vault.name}</strong>
        </div>
        <nav aria-label="Vault views">
          <Link className={view.type === 'graph' ? 'active' : ''} to={`/v/${vaultId}/graph`}>
            Graph
          </Link>
          <Link className={view.type === 'tokens' ? 'active' : ''} to={`/v/${vaultId}/tokens`}>
            Tokens
          </Link>
        </nav>
      </header>
      <div className="workspace-grid">
        <aside className={`tree-pane ${treeOpen ? 'open' : ''}`} aria-label="Vault files">
          <div className="pane-title">
            <strong>Files</strong>
            <span>{files.length}</span>
          </div>
          <FileTree
            files={files}
            {...(view.fileId === undefined ? {} : { selectedId: view.fileId })}
            onSelect={(file) => open(file.fileId)}
          />
        </aside>
        <section className="content-pane">
          {pending && <IndexPending />}
          {view.type === 'home' &&
            (files.length ? (
              <EmptyState title={`Welcome to ${vault.name}`}>
                <p>Select a file from the tree or open the graph.</p>
                <p className="readonly-badge">Read-only mirror</p>
              </EmptyState>
            ) : (
              <EmptyState title="This vault is empty">
                <p>Connect the Obsidian plugin and sync your local vault.</p>
              </EmptyState>
            ))}
          {view.type === 'graph' && <GraphView vaultId={vaultId} onOpen={open} />}
          {view.type === 'tokens' && <TokenManager vaultId={vaultId} />}
          {view.type === 'file' &&
            (!selected ? (
              <EmptyState title="File not found">
                <p>It may have moved in a newer vault revision.</p>
              </EmptyState>
            ) : selected.kind === 'markdown' ? (
              <NoteViewer vaultId={vaultId} fileId={selected.fileId} onOpen={open} />
            ) : (
              <AttachmentViewer vaultId={vaultId} file={selected} />
            ))}
        </section>
        {view.type === 'file' && selected?.kind === 'markdown' && (
          <LinksPanel links={links?.links ?? []} backlinks={links?.backlinks ?? []} onOpen={open} />
        )}
      </div>
    </main>
  );
}
