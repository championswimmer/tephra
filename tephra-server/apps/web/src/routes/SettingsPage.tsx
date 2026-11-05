import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import { ThemeSelector } from '../components/ThemeSelector';
export function SettingsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <main className="page narrow">
      <p className="eyebrow">Account</p>
      <h1>Settings</h1>
      <section className="settings-card">
        <h2>Session</h2>
        <p>
          Signed in as <strong>{user?.email}</strong>.
        </p>
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut()
              .then(() => navigate('/login', { replace: true }))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </section>
      <section className="settings-card">
        <h2>Appearance</h2>
        <p>
          Tephra uses Obsidian&apos;s default theme. The base color scheme is saved on this
          device.
        </p>
        <ThemeSelector />
      </section>
      <section className="settings-card">
        <h2>AI agents (MCP)</h2>
        <p>
          Let Claude Code, Codex, Cursor and other coding agents search and edit your notes.
          Sign-in happens in your browser — no token copy-pasting.
        </p>
        <Link to="/settings/mcp">Connect an AI agent →</Link>
      </section>
    </main>
  );
}
