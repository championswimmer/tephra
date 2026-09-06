import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import { SettingsModal } from './SettingsModal';

export function AppShell() {
  const { user } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/vaults">
          Tephra
        </Link>
        <nav aria-label="Account">
          <span className="user-email">{user?.email}</span>
          <button
            type="button"
            className="topbar-button"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
          >
            ⚙ Settings
          </button>
          <Link to="/settings">Account</Link>
        </nav>
      </header>
      <Outlet />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
