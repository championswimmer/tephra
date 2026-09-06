import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';

export function AppShell() {
  const { user } = useAuth();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/vaults">
          Tephra
        </Link>
        <nav aria-label="Account">
          <span className="user-email">{user?.email}</span>
          <Link to="/settings">Settings</Link>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
