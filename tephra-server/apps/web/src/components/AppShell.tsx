import { Link, Outlet } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useAuth } from '../app/AuthContext';

export function AppShell() {
  const { user } = useAuth();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/vaults">
          <img src="/logo-main.svg" alt="" width={28} height={28} className="brand-logo" />
          Tephra
        </Link>
        <nav aria-label="Account">
          <span className="user-email">{user?.email}</span>
          <Link className="topbar-button icon-button" to="/settings">
            <Settings size={16} aria-hidden="true" focusable="false" className="icon" />
            Settings
          </Link>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
