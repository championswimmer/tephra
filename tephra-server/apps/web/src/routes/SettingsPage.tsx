import { useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
import { McpSettingsPanel } from '../components/McpSettingsPanel';
import { ObsidianSyncSettingsPanel } from '../components/ObsidianSyncSettingsPanel';
import { ThemeSelector } from '../components/ThemeSelector';

const TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'account', label: 'Account' },
  { id: 'sync', label: 'Sync' },
  { id: 'mcp', label: 'MCP' },
] as const;

export function SettingsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const active = TABS.find((tab) => tab.id === searchParams.get('tab')) ?? TABS[0];
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState('');

  function selectTab(id: string) {
    if (id === active.id) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next);
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (index + TABS.length - 1) % TABS.length;
        break;
      case 'ArrowRight':
        nextIndex = (index + 1) % TABS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = TABS[nextIndex]!;
    selectTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  }

  return (
    <main className="page narrow settings-page">
      <p className="eyebrow">Preferences</p>
      <h1>Settings</h1>
      <div role="tablist" aria-label="Settings" className="settings-tabs">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={active.id === tab.id}
            aria-controls="settings-panel"
            tabIndex={active.id === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => handleTabKey(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${active.id}`}
        tabIndex={0}
      >
        {active.id === 'appearance' && (
          <section className="settings-card">
            <h2>Appearance</h2>
            <p>
              Tephra uses Obsidian&apos;s default theme. The base color scheme is saved on this
              device.
            </p>
            <ThemeSelector />
          </section>
        )}
        {active.id === 'account' && (
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
                setSignOutError('');
                void signOut()
                  .then(() => navigate('/login', { replace: true }))
                  .catch((caught) =>
                    setSignOutError(
                      caught instanceof Error ? caught.message : 'Unable to sign out.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
            {signOutError && (
              <p className="form-error" role="alert">
                {signOutError}
              </p>
            )}
          </section>
        )}
        {active.id === 'sync' && <ObsidianSyncSettingsPanel />}
        {active.id === 'mcp' && <McpSettingsPanel />}
      </div>
    </main>
  );
}
