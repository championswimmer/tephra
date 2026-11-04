import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy } from 'lucide-react';

interface AgentGuide {
  id: string;
  name: string;
  steps: string[];
  snippets: { label: string; code: string }[];
  note?: string;
}

export function agentGuides(url: string): AgentGuide[] {
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      steps: [
        'Add the server.',
        'Inside Claude Code run /mcp, pick “tephra” and choose Authenticate. Your browser opens Tephra; sign in and press Authorize.',
      ],
      snippets: [{ label: 'Terminal', code: `claude mcp add --transport http tephra ${url}` }],
    },
    {
      id: 'codex',
      name: 'Codex',
      steps: [
        'Add the server, then sign in. Codex opens your browser and receives the result on a localhost callback.',
      ],
      snippets: [
        { label: 'Terminal', code: `codex mcp add tephra --url ${url}\ncodex mcp login tephra` },
        { label: 'or ~/.codex/config.toml', code: `[mcp_servers.tephra]\nurl = "${url}"` },
      ],
      note: 'On a remote/headless machine use `codex mcp login tephra --no-browser` and open the printed link yourself.',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      steps: [
        'Add this to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).',
        'Open Cursor Settings → MCP and click “Connect” next to tephra to start the browser sign-in.',
      ],
      snippets: [
        { label: 'mcp.json', code: JSON.stringify({ mcpServers: { tephra: { url } } }, null, 2) },
      ],
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      steps: [
        'Open the MCP panel (Manage MCP Servers → View raw config) and add the server to mcp_config.json. Antigravity uses the serverUrl key for remote servers.',
        'Restart or refresh MCP servers; Antigravity starts the browser sign-in the first time the server is used (in the CLI run /mcp to authenticate).',
      ],
      snippets: [
        { label: 'mcp_config.json', code: JSON.stringify({ mcpServers: { tephra: { serverUrl: url } } }, null, 2) },
      ],
      note: 'The file lives under ~/.gemini/ (path differs between Antigravity versions). If your version does not offer browser sign-in, create an API token under a vault’s Tokens and add "headers": { "Authorization": "Bearer <token>" }.',
    },
    {
      id: 'pi',
      name: 'Pi',
      steps: [
        'Add the server (Pi has native MCP support), then sign in. Pi opens your browser and receives the result on a localhost callback.',
        'Check the connection with pi mcp list. Inside a Pi session you can also use /mcp login tephra.',
      ],
      snippets: [
        { label: 'Terminal', code: `pi mcp add tephra ${url}\npi mcp login tephra` },
        { label: 'or ~/.pi/agent/mcp.json', code: JSON.stringify({ mcpServers: { tephra: { url } } }, null, 2) },
      ],
      note: 'Credentials are stored in ~/.pi/agent/mcp-auth.json; remove them with pi mcp logout tephra. Use pi mcp add -l to save the server to the current project (.pi/mcp.json) instead. Exact flags may vary by Pi version — check pi mcp --help.',
    },
  ];
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="token-once">
      <strong>{label}</strong>
      <code style={{ whiteSpace: 'pre' }}>{code}</code>
      <div>
        <button type="button" className="icon-button" onClick={() => void navigator.clipboard.writeText(code)}>
          <Copy size={14} aria-hidden="true" focusable="false" className="icon" />
          Copy
        </button>
      </div>
    </div>
  );
}

export function McpSettingsPage() {
  const url = `${window.location.origin}/mcp`;
  const guides = agentGuides(url);
  const [active, setActive] = useState(guides[0]!.id);
  const guide = guides.find((g) => g.id === active)!;
  return (
    <main className="page narrow">
      <p className="eyebrow">
        <Link to="/settings">Settings</Link> / AI agents
      </p>
      <h1>Connect an AI agent (MCP)</h1>
      <section className="settings-card">
        <h2>How sign-in works</h2>
        <ol>
          <li>Add the server URL below to your agent.</li>
          <li>The agent opens this site in your browser. Sign in to Tephra if needed.</li>
          <li>Choose a vault and access level and press Authorize.</li>
          <li>
            Tephra sends a one-time code to the agent’s localhost callback; the agent exchanges it
            for its own revocable API token. You never copy a secret by hand.
          </li>
        </ol>
        <p>
          Server URL: <code>{url}</code>
        </p>
        <p className="muted">
          Issued tokens appear as “MCP: …” in each vault’s Tokens list, where you can revoke them.
        </p>
      </section>
      <section className="settings-card">
        <div role="tablist" aria-label="Agents" className="agent-tabs">
          {guides.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={g.id === active}
              className={g.id === active ? 'primary' : undefined}
              onClick={() => setActive(g.id)}
            >
              {g.name}
            </button>
          ))}
        </div>
        <h2>{guide.name}</h2>
        <ol>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {guide.snippets.map((snippet) => (
          <CodeBlock key={snippet.label} {...snippet} />
        ))}
        {guide.note && <p className="muted">{guide.note}</p>}
      </section>
    </main>
  );
}
