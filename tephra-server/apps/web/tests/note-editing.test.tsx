/**
 * NoteViewer editing tests: edit affordance gating, the save flow, dirty
 * gating, the 409 conflict banner, and the size/attachment read-only rules.
 *
 * The real `TephraEditor` (CodeMirror) is stubbed with a textarea that keeps
 * the same contract: `onDirtyChange` on edits, `onSave` on Ctrl/Cmd+S
 * (including the synthetic keydown the toolbar Save dispatches). The pure
 * helpers (`isDirty`, `resolveConflict`) stay real.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, api } from '../src/api/client';
import { NoteViewer } from '../src/components/NoteViewer';
import { MAX_EDIT_BYTES } from '../src/components/NoteViewer';
import type { VaultFile } from '../src/api/types';
import type * as MarkdownEditor from '@tephra/markdown-editor';
import { ThemeProvider } from '../src/theme/ThemeContext';

vi.mock('@tephra/markdown-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof MarkdownEditor>();
  function StubTephraEditor({
    docKey,
    baseText,
    onDirtyChange,
    onSave,
  }: {
    docKey: string;
    baseText: string;
    onDirtyChange?: (dirty: boolean) => void;
    onSave?: (text: string) => void;
  }) {
    const [value, setValue] = useState(baseText);
    const live = useRef({ baseText, onDirtyChange, onSave });
    live.current = { baseText, onDirtyChange, onSave };
    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    // Remount/reload semantics: a new docKey or base text replaces the doc.
    useEffect(() => {
      setValue(baseText);
    }, [docKey, baseText]);
    // Native listener so the synthetic Ctrl/Cmd+S-dispatched keydown from
    // the toolbar Save reaches the same path as a real keypress.
    useEffect(() => {
      const area = areaRef.current;
      if (!area) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
          event.preventDefault();
          live.current.onSave?.((event.target as HTMLTextAreaElement).value);
        }
      };
      area.addEventListener('keydown', onKeyDown);
      return () => area.removeEventListener('keydown', onKeyDown);
    }, []);
    return (
      <textarea
        ref={areaRef}
        data-testid="tephra-editor-stub"
        data-doc-key={docKey}
        data-tephra-editor-save-target="true"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          live.current.onDirtyChange?.(event.target.value !== live.current.baseText);
        }}
      />
    );
  }
  return { ...actual, TephraEditor: StubTephraEditor };
});

function markdownFile(overrides: Partial<VaultFile> = {}): VaultFile {
  return {
    fileId: 'file-1',
    path: 'Notes/Hello.md',
    kind: 'markdown',
    size: 11,
    mtime: 1000,
    blobHash: 'a'.repeat(64),
    ...overrides,
  };
}

function attachmentFile(): VaultFile {
  return {
    fileId: 'file-9',
    path: 'Assets/photo.png',
    kind: 'attachment',
    mimeType: 'image/png',
    size: 42,
    mtime: 1000,
  };
}

function renderViewer(props: {
  file?: VaultFile;
  onSaved?: () => void;
  fileId?: string;
}) {
  const rendered = vi.spyOn(api, 'rendered');
  rendered.mockResolvedValue({ title: 'Hello', html: '<p>Hello</p>' });
  const source = vi.spyOn(api, 'source');
  source.mockResolvedValue('# Hello\n');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <ThemeProvider>{children}</ThemeProvider>
    </MemoryRouter>
  );
  const view = render(
    <NoteViewer
      vaultId="vault-1"
      fileId={props.fileId ?? props.file?.fileId ?? 'file-1'}
      {...(props.file ? { file: props.file } : {})}
      onOpen={vi.fn()}
      {...(props.onSaved ? { onSaved: props.onSaved } : {})}
    />,
    { wrapper },
  );
  return { ...view, rendered, source };
}

async function enterEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.findByTestId('tephra-editor-stub');
}

describe('NoteViewer editing', () => {
  it('shows the Edit toggle for markdown files only', async () => {
    const user = userEvent.setup();
    const { unmount } = renderViewer({ file: markdownFile() });
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    // Raw source toggle keeps working alongside the new mode.
    await user.click(screen.getByRole('button', { name: 'Raw source' }));
    expect(await screen.findByText('# Hello')).toBeInTheDocument();
    unmount();
  });

  it('offers no edit affordance for attachments', async () => {
    renderViewer({ file: attachmentFile() });
    await screen.findByRole('heading', { name: 'Hello' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raw source' })).toBeInTheDocument();
  });

  it('hides the editor for markdown files over 1 MB with a notice', async () => {
    renderViewer({ file: markdownFile({ size: MAX_EDIT_BYTES + 1 }) });
    await screen.findByRole('heading', { name: 'Hello' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('larger than 1 MB');
  });

  it('keeps Save disabled until the text is dirty', async () => {
    const user = userEvent.setup();
    renderViewer({ file: markdownFile() });
    const editor = await enterEdit(user);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('No changes');
    await user.type(editor, ' more');
    expect(save).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
  });

  it('saves with If-Match set to the base blob hash and shows saved state', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const save = vi.spyOn(api, 'saveContent');
    save.mockResolvedValue({
      status: 'committed',
      revision: 8,
      blobHash: 'b'.repeat(64),
      size: 20,
      mtime: 2000,
    });
    renderViewer({ file: markdownFile(), onSaved });
    const editor = await enterEdit(user);
    await user.type(editor, ' more');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('vault-1', 'file-1', '# Hello\n more', 'a'.repeat(64));
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('sends Ctrl/Cmd+S in the editor to the same save path', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveContent');
    save.mockResolvedValue({
      status: 'committed',
      revision: 8,
      blobHash: 'b'.repeat(64),
      size: 20,
      mtime: 2000,
    });
    renderViewer({ file: markdownFile() });
    const editor = (await enterEdit(user)) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# Hello\nedited' } });
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('vault-1', 'file-1', '# Hello\nedited', 'a'.repeat(64));
    });
  });

  it('shows the conflict banner on 409 and Overwrite retries with the server hash', async () => {
    const user = userEvent.setup();
    const current = { blobHash: 'c'.repeat(64), size: 30, mtime: 3000, revision: 9 };
    const save = vi.spyOn(api, 'saveContent');
    save.mockRejectedValueOnce(
      new ApiError(409, 'EDIT_CONFLICT', 'The file changed since it was loaded.', {
        error: { code: 'EDIT_CONFLICT', message: 'changed' },
        current,
      }),
    );
    save.mockResolvedValueOnce({
      status: 'committed',
      revision: 10,
      blobHash: 'd'.repeat(64),
      size: 30,
      mtime: 4000,
    });
    const { source } = renderViewer({ file: markdownFile() });
    source.mockResolvedValue('# Hello\nremote edit\n');
    const editor = await enterEdit(user);
    await user.type(editor, ' local edit');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Someone else saved this note first');
    // Remote mtime (3000) is past the base (1000): remote-wins is suggested.
    expect(banner).toHaveTextContent('The server version is newer');
    await user.click(within(banner).getByRole('button', { name: 'Overwrite with my version' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    });
    expect(save.mock.calls[1]).toEqual([
      'vault-1',
      'file-1',
      expect.stringContaining('local edit'),
      'c'.repeat(64),
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('Reload server version replaces the editor text with the server bytes', async () => {
    const user = userEvent.setup();
    const current = { blobHash: 'c'.repeat(64), size: 30, mtime: 3000, revision: 9 };
    const save = vi.spyOn(api, 'saveContent') as Mock;
    save.mockRejectedValue(
      new ApiError(409, 'EDIT_CONFLICT', 'The file changed since it was loaded.', {
        error: { code: 'EDIT_CONFLICT', message: 'changed' },
        current,
      }),
    );
    const { source } = renderViewer({ file: markdownFile() });
    source.mockResolvedValue('# Hello\nremote edit\n');
    const editor = (await enterEdit(user)) as HTMLTextAreaElement;
    await user.type(editor, ' local edit');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const banner = await screen.findByRole('alert');
    await user.click(within(banner).getByRole('button', { name: 'Reload server version' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect((screen.getByTestId('tephra-editor-stub') as HTMLTextAreaElement).value).toBe(
      '# Hello\nremote edit\n',
    );
    // A new docKey forces the editor to remount from the server version
    // rather than restoring the discarded local session.
    expect(screen.getByTestId('tephra-editor-stub')).not.toHaveAttribute(
      'data-doc-key',
      'vault-1:file-1:0',
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a generic error when saving fails without a conflict', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, 'saveContent');
    save.mockRejectedValue(new ApiError(500, 'HTTP_ERROR', 'Boom.'));
    renderViewer({ file: markdownFile() });
    const editor = await enterEdit(user);
    await user.type(editor, ' x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom.');
  });
});
