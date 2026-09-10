import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { LinksResponse, ResolveResponse, Vault, VaultFile } from '../api/types';
import { AttachmentViewer } from '../components/AttachmentViewer';
import { FileTree } from '../components/FileTree';
import { GraphView } from '../components/GraphView';
import { LocalGraph } from '../components/LocalGraph';
import { LinksPanel } from '../components/LinksPanel';
import { NoteViewer } from '../components/NoteViewer';
import { EmptyState, ErrorState, IndexPending, Loading } from '../components/Status';
import { TokenManager } from '../components/TokenManager';
import { encodePathForHash, parseHashView } from '../vault/path-url';

type ResolveState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; response: ResolveResponse }
  | { status: 'error'; error: unknown };

/**
 * Path-addressed workspace. Notes are addressed by the `location.hash`
 * (`#/path/to/file.md`); the workspace resolves the requested path once via
 * `GET …/resolve` and then uses the returned `fileId` for all existing
 * `/files/:fileId/*` endpoints (content, rendered, links, backlinks).
 */
export function VaultWorkspace() {
  // `:vaultSlug` is the globally-unique vault name in the URL. It is passed
  // straight to the API, which also accepts the internal id for sync clients.
  const { vaultSlug = '', '*': rest } = useParams();
  const vaultId = vaultSlug;
  const location = useLocation();
  const navigate = useNavigate();
  const view = parseHashView(rest, location.hash);
  const requestedPath = view.type === 'file' ? view.path : undefined;
  const [vault, setVault] = useState<Vault>();
  const [files, setFiles] = useState<VaultFile[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [links, setLinks] = useState<LinksResponse>();
  const [resolveState, setResolveState] = useState<ResolveState>({ status: 'idle' });
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

  // Single path→id resolution per requested path. Afterwards everything
  // (rendered, source, links) keys off the resolved fileId as before.
  useEffect(() => {
    if (view.type !== 'file' || !view.path) {
      setResolveState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setResolveState({ status: 'loading' });
    setLinks(undefined);
    void api
      .resolve(vaultId, view.path)
      .then((response) => {
        if (cancelled) return;
        setResolveState({ status: 'ready', response });
        // Canonicalize the URL for case/normalized/historic matches and
        // surface where the link pointed before the move.
        if (
          response.match !== 'exact' &&
          response.canonicalPath !== response.requestedPath &&
          typeof window !== 'undefined'
        ) {
          const canonical = `#/${encodePathForHash(response.canonicalPath)}`;
          window.history.replaceState(null, '', `${window.location.pathname}${canonical}`);
        }
      })
      .catch((caught) => {
        if (!cancelled) setResolveState({ status: 'error', error: caught });
      });
    return () => {
      cancelled = true;
    };
  }, [vaultId, view.type, requestedPath]);

  const resolvedFile = resolveState.status === 'ready' ? resolveState.response.file : undefined;
  const resolvedFileId = resolvedFile?.fileId;
  useEffect(() => {
    setLinks(undefined);
    if (resolvedFileId)
      void api
        .links(vaultId, resolvedFileId)
        .then(setLinks)
        .catch(() => setLinks({ links: [], backlinks: [] }));
  }, [vaultId, resolvedFileId]);

  const pathByFileId = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of files ?? []) map.set(file.fileId, file.path);
    if (resolvedFile) map.set(resolvedFile.fileId, resolvedFile.path);
    return map;
  }, [files, resolvedFile]);

  // `selected` prefers the file list (freshest kind/size metadata) and falls
  // back to the resolve payload for files the list has not picked up yet.
  const selected = useMemo(() => {
    if (!resolvedFile) return undefined;
    return (
      files?.find((file) => file.fileId === resolvedFile.fileId) ?? {
        ...resolvedFile,
        size: 0,
        mtime: 0,
      }
    );
  }, [files, resolvedFile]);

  const movedFrom =
    resolveState.status === 'ready' &&
    resolveState.response.match !== 'exact' &&
    resolveState.response.canonicalPath !== resolveState.response.requestedPath
      ? (resolveState.response.movedFromPath ?? resolveState.response.requestedPath)
      : undefined;

  const open = (path: string) => {
    navigate({
      pathname: `/v/${encodeURIComponent(vault?.name ?? vaultId)}/`,
      hash: `#/${encodePathForHash(path)}`,
    });
    setTreeOpen(false);
  };
  const openFileId = (fileId: string) => {
    const path = pathByFileId.get(fileId);
    if (path !== undefined) open(path);
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
          <Link
            className={view.type === 'graph' ? 'active' : ''}
            to={`/v/${encodeURIComponent(vault?.name ?? vaultId)}/graph`}
          >
            Graph
          </Link>
          <Link
            className={view.type === 'tokens' ? 'active' : ''}
            to={`/v/${encodeURIComponent(vault?.name ?? vaultId)}/tokens`}
          >
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
            {...(selected === undefined ? {} : { selectedPath: selected.path })}
            onSelect={open}
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
          {view.type === 'graph' && (
            <GraphView
              vaultId={vaultId}
              onOpen={open}
              {...(resolvedFileId === undefined ? {} : { selectedId: resolvedFileId })}
            />
          )}
          {view.type === 'tokens' && <TokenManager vaultId={vaultId} />}
          {view.type === 'file' &&
            (resolveState.status === 'loading' || resolveState.status === 'idle' ? (
              <Loading label="Resolving path…" />
            ) : resolveState.status === 'error' ? (
              isGone(resolveState.error) ? (
                <EmptyState title="File not found">
                  <p>This note was deleted or never existed.</p>
                </EmptyState>
              ) : (
                <ErrorState error={resolveState.error} retry={() => void load()} />
              )
            ) : !selected ? (
              <EmptyState title="File not found">
                <p>It may have moved in a newer vault revision.</p>
              </EmptyState>
            ) : (
              <>
                {movedFrom && (
                  <p className="notice" role="status">
                    Moved from {movedFrom}
                  </p>
                )}
                {selected.kind === 'markdown' ? (
                  <>
                    <NoteViewer
                      vaultId={vaultId}
                      fileId={selected.fileId}
                      onOpen={open}
                      getPathForFileId={(fileId) => pathByFileId.get(fileId)}
                    />
                    <LocalGraph vaultId={vaultId} fileId={selected.fileId} onOpen={open} />
                  </>
                ) : (
                  <AttachmentViewer vaultId={vaultId} file={selected} />
                )}
              </>
            ))}
        </section>
        {view.type === 'file' && selected?.kind === 'markdown' && (
          <LinksPanel
            links={links?.links ?? []}
            backlinks={links?.backlinks ?? []}
            onOpen={openFileId}
          />
        )}
      </div>
    </main>
  );
}

function isGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 410 || error.status === 409)
  );
}
