import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loading } from '../components/Status';
import { useAuth } from './AuthContext';

export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();
  if (state === 'loading')
    return (
      <main>
        <Loading label="Checking your session…" />
      </main>
    );
  if (state === 'setup-required') return <Navigate to="/setup" replace />;
  if (state !== 'authenticated')
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}
export function PublicOnly() {
  const { state } = useAuth();
  if (state === 'loading')
    return (
      <main>
        <Loading label="Checking your session…" />
      </main>
    );
  if (state === 'authenticated') return <Navigate to="/vaults" replace />;
  if (state === 'setup-required') return <Navigate to="/setup" replace />;
  return <Outlet />;
}
export function SetupOnly() {
  const { state } = useAuth();
  if (state === 'loading')
    return (
      <main>
        <Loading label="Checking server setup…" />
      </main>
    );
  if (state === 'setup-required') return <Outlet />;
  return <Navigate to={state === 'authenticated' ? '/vaults' : '/login'} replace />;
}
