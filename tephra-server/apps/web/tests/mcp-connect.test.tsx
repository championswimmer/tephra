import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { ConnectAgentPage } from '../src/routes/ConnectAgentPage';
import { AuthorizedAgents, McpSettingsPanel } from '../src/components/McpSettingsPanel';

describe('Authorized agents', () => {
  it('lists MCP tokens across vaults and revokes one', async () => {
    vi.spyOn(api, 'vaults').mockResolvedValue({
      vaults: [
        { id: 'v1', name: 'Notes', latestRevision: 1 },
        { id: 'v2', name: 'Work', latestRevision: 1 },
      ],
    });
    vi.spyOn(api, 'tokens').mockImplementation(async (id) => ({
      tokens:
        id === 'v1'
          ? [
              { id: 't1', name: 'MCP: Claude Code', createdAt: 2, scopes: ['vault:read-metadata', 'vault:write'] },
              { id: 't2', name: 'Plugin', createdAt: 1 },
              { id: 't3', name: 'MCP: Old', createdAt: 1, revokedAt: 5 },
            ]
          : [{ id: 't4', name: 'MCP: Codex', createdAt: 3, scopes: ['vault:read-metadata'] }],
    }));
    const revoke = vi.spyOn(api, 'revokeToken').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<AuthorizedAgents />);
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText('Plugin')).not.toBeInTheDocument();
    expect(screen.queryByText('Old')).not.toBeInTheDocument();
    expect(screen.getByText(/Work · read only/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!);
    expect(revoke).toHaveBeenCalledWith('v1', 't1');
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });
});

describe('MCP settings page', () => {
  it('shows per-agent setup for the supported agents', async () => {
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults: [] });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <McpSettingsPanel />
      </MemoryRouter>,
    );
    expect(screen.getByText(/claude mcp add --transport http tephra/)).toBeInTheDocument();
    for (const name of ['Codex', 'Cursor', 'Antigravity', 'Pi']) {
      await user.click(screen.getByRole('tab', { name }));
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/pi mcp login tephra/)).toBeInTheDocument();
  });
});

describe('Connect agent consent page', () => {
  const url = '/connect?client_id=tmc_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb&code_challenge=abc&state=s1';
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/connect" element={<ConnectAgentPage />} />
        </Routes>
      </MemoryRouter>,
    );

  it('authorizes the chosen vault and access level', async () => {
    vi.spyOn(api, 'oauthClient').mockResolvedValue({ name: 'Claude Code', redirectHost: '127.0.0.1:1' });
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults: [{ id: 'v1', name: 'Notes', latestRevision: 1 }] });
    const decide = vi.spyOn(api, 'oauthDecision').mockResolvedValue({ redirectUrl: 'about:blank' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/is asking for access/);
    await user.click(screen.getByLabelText('Read only'));
    await user.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(decide).toHaveBeenCalledWith({
      clientId: 'tmc_x',
      redirectUri: 'http://127.0.0.1:1/cb',
      codeChallenge: 'abc',
      state: 's1',
      decision: 'approve',
      vaultId: 'v1',
      access: 'read',
    });
    expect(assign).toHaveBeenCalledWith('about:blank');
    vi.unstubAllGlobals();
  });
});
