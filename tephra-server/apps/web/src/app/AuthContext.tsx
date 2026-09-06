import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../api/client';
import type { User } from '../api/types';

type AuthState = 'loading' | 'authenticated' | 'anonymous' | 'setup-required';
interface AuthValue {
  state: AuthState;
  user: User | null;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('loading');
  const [user, setUser] = useState<User | null>(null);
  const refresh = useCallback(async () => {
    setState('loading');
    try {
      const result = await api.me();
      setUser(result.user);
      setState('authenticated');
    } catch (error) {
      setUser(null);
      if (
        error instanceof ApiError &&
        (error.code === 'BOOTSTRAP_REQUIRED' || error.status === 503)
      )
        setState('setup-required');
      else setState('anonymous');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setState('anonymous');
  }, []);
  const value = useMemo(() => ({ state, user, refresh, signOut }), [state, user, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
