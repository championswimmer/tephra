import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  resolveBaseScheme,
  type ObsidianThemeDefinition,
  type ThemeBase,
} from './themes';

export const THEME_STORAGE_KEY = 'tephra:appearance-base';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredBase(): ThemeBase {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Storage unavailable (private mode, SSR) — fall through to default.
  }
  return 'system';
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * Apply the resolved theme to `<html>`: Obsidian-compatible
 * `theme-light` / `theme-dark` classes, `color-scheme`, and the
 * `theme-color` meta tag so the mobile status bar matches.
 */
export function applyThemeToDocument(theme: ObsidianThemeDefinition): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  root.classList.add(theme.scheme === 'dark' ? 'theme-dark' : 'theme-light');
  root.style.colorScheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.variables)) {
    root.style.setProperty(name, value);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.themeColor);
}

interface ThemeContextValue {
  /** User's stored preference: explicit scheme or follow the OS. */
  base: ThemeBase;
  /** Concrete resolved Obsidian theme. */
  theme: ObsidianThemeDefinition;
  setBase: (base: ThemeBase) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [base, setBaseState] = useState<ThemeBase>(readStoredBase);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setBase = useCallback((next: ThemeBase) => {
    setBaseState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures; the theme still applies in-memory.
    }
  }, []);

  const theme = useMemo(() => resolveBaseScheme(base, systemDark), [base, systemDark]);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const value = useMemo(() => ({ base, theme, setBase }), [base, theme, setBase]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider.');
  return ctx;
}
