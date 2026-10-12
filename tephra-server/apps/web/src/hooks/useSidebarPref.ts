import { useCallback, useState } from 'react';

function readSidebarPref(key: string, fallback: boolean): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored !== 'false';
  } catch {
    return fallback;
  }
}

function writeSidebarPref(key: string, open: boolean): void {
  try {
    window.localStorage?.setItem(key, String(open));
  } catch {
    // UI preference only; ignore persistence failures (private mode, etc.).
  }
}

/** Open/closed state of a sidebar, persisted in localStorage. */
export function useSidebarPref(key: string, fallback: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => readSidebarPref(key, fallback));
  const toggle = useCallback(() => {
    setOpen((prev) => {
      writeSidebarPref(key, !prev);
      return !prev;
    });
  }, [key]);
  return [open, toggle];
}
