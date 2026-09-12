import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Settings } from 'lucide-react';
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
            className="topbar-button icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
          >
            <Settings size={16} aria-hidden="true" focusable="false" className="icon" />
            Settings
          </button>
          <Link to="/settings">Account</Link>
        </nav>
      </header>
      <Outlet />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
