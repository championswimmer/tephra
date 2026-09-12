import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="status" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="status error" role="alert">
      <TriangleAlert size={16} aria-hidden="true" focusable="false" className="icon" />
      <strong>Unable to load</strong>
      <span>{message}</span>
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="status empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
export function IndexPending() {
  return (
    <p className="notice" role="status">
      Indexing is still in progress. Links and graph results may be incomplete.
    </p>
  );
}
