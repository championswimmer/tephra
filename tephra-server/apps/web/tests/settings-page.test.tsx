import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { useAuth } from '../src/app/AuthContext';
import { SettingsPage } from '../src/routes/SettingsPage';
import { THEME_STORAGE_KEY, ThemeProvider } from '../src/theme/ThemeContext';

vi.mock('../src/app/AuthContext', () => ({ useAuth: vi.fn() }));
const signOut = vi.fn<() => Promise<void>>();

function HistoryControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Location">{location.pathname + location.search}</output>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}

function renderSettings(url = '/settings') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ThemeProvider>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/login" element={<h1>Sign in</h1>} />
        </Routes>
        <HistoryControls />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('Settings tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    signOut.mockReset().mockResolvedValue(undefined);
    vi.mocked(useAuth).mockReturnValue({
      state: 'authenticated',
      user: { id: 'user-1', email: 'tephra@example.com' },
      refresh: vi.fn(),
      signOut,
    });
    vi.spyOn(api, 'obsidianAvailable').mockResolvedValue({ available: true });
    vi.spyOn(api, 'obsidianAccount').mockResolvedValue({
      account: { authenticated: false, email: null, lastErrorCode: null },
    });
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults: [] });
  });

  it('defaults to Appearance and only loads the active panel', async () => {
    const user = userEvent.setup();
    renderSettings();
    expect(
      within(screen.getByRole('tablist', { name: 'Settings' }))
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Appearance', 'Account', 'Sync', 'MCP']);
    const tab = screen.getByRole('tab', { name: 'Appearance', selected: true });
    const panel = screen.getByRole('tabpanel', { name: 'Appearance' });
    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(screen.queryByRole('heading', { name: 'Session' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Obsidian Sync account' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Authorized agents' })).not.toBeInTheDocument();
    expect(api.obsidianAvailable).not.toHaveBeenCalled();
    expect(api.vaults).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: /Dark/ }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await user.click(screen.getByRole('tab', { name: 'Account' }));
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByRole('radio', { name: /Dark/ })).toBeChecked();
  });

  it.each([
    ['appearance', 'Appearance'],
    ['account', 'Account'],
    ['sync', 'Sync'],
    ['mcp', 'MCP'],
    ['unknown', 'Appearance'],
  ])('opens the %s URL with the %s tab selected', async (id, label) => {
    renderSettings(`/settings?tab=${id}`);
    expect(screen.getByRole('tab', { name: label, selected: true })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('tabpanel', { name: label })).toBeInTheDocument();
    expect(
      within(screen.getByRole('tablist', { name: 'Settings' }))
        .getAllByRole('tab')
        .filter((tab) => tab.tabIndex === 0),
    ).toHaveLength(1);
    if (id === 'sync') await screen.findByText('Not signed in to Obsidian.');
    if (id === 'mcp') await screen.findByText('No agents have been authorized yet.');
  });

  it('updates the URL on selection and follows Back and Forward', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('tab', { name: 'Account' }));
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings?tab=account');
    await user.click(screen.getByRole('tab', { name: 'Sync' }));
    await screen.findByText('Not signed in to Obsidian.');
    await user.click(screen.getByRole('tab', { name: 'MCP' }));
    await screen.findByText('No agents have been authorized yet.');
    expect(screen.getByLabelText('Location')).toHaveTextContent('/settings?tab=mcp');
    await user.click(screen.getByRole('tab', { name: 'MCP' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('tab', { name: 'Sync', selected: true })).toBeInTheDocument();
    await screen.findByText('Not signed in to Obsidian.');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('tab', { name: 'Account', selected: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByRole('tab', { name: 'Sync', selected: true })).toBeInTheDocument();
    await screen.findByText('Not signed in to Obsidian.');
  });

  it('supports arrow keys, Home and End with one tab stop', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Account', selected: true })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'MCP', selected: true })).toHaveFocus();
    await screen.findByText('No agents have been authorized yet.');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Appearance', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'MCP', selected: true })).toHaveFocus();
    await screen.findByText('No agents have been authorized yet.');
    await user.keyboard('{Home}{Tab}');
    expect(screen.getByRole('tabpanel', { name: 'Appearance' })).toHaveFocus();
  });

  it('shows the Tephra session and signs out from Account', async () => {
    let finish!: () => void;
    signOut.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderSettings('/settings?tab=account');
    expect(screen.getByRole('tabpanel', { name: 'Account' })).toHaveTextContent(
      'Signed in as tephra@example.com.',
    );
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
    expect(signOut).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps the Account tab usable when sign-out fails', async () => {
    signOut.mockRejectedValueOnce(new Error('Unable to reach the Tephra server.'));
    const user = userEvent.setup();
    renderSettings('/settings?tab=account');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the Tephra server.',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
  });

  it('keeps Obsidian credentials in Sync and clears the form when leaving the tab', async () => {
    const login = vi.spyOn(api, 'obsidianAccountLogin').mockResolvedValue({
      account: { authenticated: true, email: 'obsidian@example.com', lastErrorCode: null },
    });
    const user = userEvent.setup();
    renderSettings('/settings?tab=sync');
    await user.type(await screen.findByLabelText('Obsidian email'), 'obsidian@example.com');
    await user.type(screen.getByLabelText('Obsidian password'), 'private-password');
    await user.type(screen.getByLabelText('Two-factor code (if enabled)'), '123456');
    await user.click(screen.getByRole('tab', { name: 'Account' }));
    expect(screen.queryByLabelText('Obsidian password')).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Account' })).toHaveTextContent(
      'tephra@example.com',
    );
    await user.click(screen.getByRole('tab', { name: 'Sync' }));
    expect(await screen.findByLabelText('Obsidian password')).toHaveValue('');
    expect(screen.getByLabelText('Two-factor code (if enabled)')).toHaveValue('');
    await user.type(screen.getByLabelText('Obsidian email'), 'obsidian@example.com');
    await user.type(screen.getByLabelText('Obsidian password'), 'private-password');
    await user.click(screen.getByRole('button', { name: 'Sign in to Obsidian' }));
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: 'obsidian@example.com',
        password: 'private-password',
      }),
    );
    expect(await screen.findByText('Signed in as obsidian@example.com.')).toBeInTheDocument();
  });

  it('embeds MCP guides and authorized agents within the Settings page', async () => {
    const user = userEvent.setup();
    renderSettings('/settings?tab=mcp');
    await screen.findByText('No agents have been authorized yet.');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const panel = screen.getByRole('tabpanel', { name: 'MCP' });
    expect(
      within(panel).getByRole('heading', { name: 'Connect an AI agent (MCP)' }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/claude mcp add --transport http/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('tab', { name: 'Codex' }));
    expect(
      within(panel).getByText(/codex mcp login tephra/, { selector: 'code' }),
    ).toBeInTheDocument();
    expect(api.obsidianAvailable).not.toHaveBeenCalled();
  });
});
