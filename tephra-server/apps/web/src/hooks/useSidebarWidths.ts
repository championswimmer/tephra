import { useCallback, useEffect, useState } from 'react';

export const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;

function maximumWidth(): number {
  return typeof window === 'undefined'
    ? SIDEBAR_MAX_WIDTH
    : Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.4)));
}

function readWidth(key: string, fallback: number): number {
  try {
    const stored = window.localStorage.getItem(key);
    const width = stored === null || stored.trim() === '' ? NaN : Number(stored);
    return Number.isFinite(width) && width > 0
      ? Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width))
      : fallback;
  } catch {
    return fallback;
  }
}

function useWidth(key: string, fallback: number, max: number) {
  const [width, setWidth] = useState(() => readWidth(key, fallback));
  const resize = useCallback(
    (requested: number) => {
      if (!Number.isFinite(requested)) return;
      const next = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, requested)));
      setWidth(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // Width is a UI preference; unavailable storage must not prevent resizing.
      }
    },
    [key, max],
  );
  return { width: Math.min(width, max), resize };
}

/** Independent local browser preferences, bounded to leave room for the main pane. */
export function useSidebarWidths() {
  const [maxWidth, setMaxWidth] = useState(maximumWidth);
  useEffect(() => {
    const updateMaximum = () => setMaxWidth(maximumWidth());
    window.addEventListener('resize', updateMaximum);
    return () => window.removeEventListener('resize', updateMaximum);
  }, []);
  const left = useWidth('tephra:sidebar-left-width', 240, maxWidth);
  const right = useWidth('tephra:sidebar-right-width', 220, maxWidth);
  return { left, right, minWidth: SIDEBAR_MIN_WIDTH, maxWidth };
}
