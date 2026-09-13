import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileType,
  FileVideo,
} from 'lucide-react';
import { FileIcon, fileIconForFile } from '../src/components/FileIcon';

describe('fileIconForFile', () => {
  it('maps markdown files to FileText regardless of mime', () => {
    expect(fileIconForFile({ kind: 'markdown', path: 'Notes/Today.md' })).toBe(FileText);
  });

  it('maps mime types to media icons', () => {
    expect(fileIconForFile({ kind: 'attachment', mimeType: 'image/png', path: 'cover.png' })).toBe(
      FileImage,
    );
    expect(fileIconForFile({ kind: 'attachment', mimeType: 'video/mp4', path: 'clip.mp4' })).toBe(
      FileVideo,
    );
    expect(fileIconForFile({ kind: 'attachment', mimeType: 'audio/mpeg', path: 'song.mp3' })).toBe(
      FileAudio,
    );
    expect(
      fileIconForFile({ kind: 'attachment', mimeType: 'application/pdf', path: 'doc.pdf' }),
    ).toBe(FileType);
  });

  it('falls back to the file extension when no mime is known', () => {
    expect(fileIconForFile({ kind: 'attachment', path: 'photo.webp' })).toBe(FileImage);
    expect(fileIconForFile({ kind: 'attachment', path: 'movie.mov' })).toBe(FileVideo);
    expect(fileIconForFile({ kind: 'attachment', path: 'sound.ogg' })).toBe(FileAudio);
    expect(fileIconForFile({ kind: 'attachment', path: 'paper.pdf' })).toBe(FileType);
    expect(fileIconForFile({ kind: 'attachment', path: 'app.ts' })).toBe(FileCode);
    expect(fileIconForFile({ kind: 'attachment', path: 'backup.zip' })).toBe(FileArchive);
  });

  it('falls back to the generic File icon for unknown types', () => {
    expect(fileIconForFile({ kind: 'attachment', path: 'mystery.xyz' })).toBe(File);
    expect(fileIconForFile({ kind: 'attachment', path: 'noextension' })).toBe(File);
  });
});

describe('FileIcon', () => {
  it('renders a decorative Lucide SVG', () => {
    const { container } = render(
      <FileIcon file={{ kind: 'attachment', mimeType: 'image/png', path: 'cover.png' }} />,
    );
    const svg = container.querySelector('svg.lucide[aria-hidden="true"]');
    expect(svg).toBeInTheDocument();
  });
});
