import type { VaultPathIndex } from '@tephra/link-resolver';

export interface HeadingInfo {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface BlockInfo {
  id: string;
  line: number;
}

export type LinkSyntax = 'wiki' | 'markdown';

export interface ParsedLink {
  raw: string;
  linkPath: string;
  subpath?: string;
  displayText?: string;
  isEmbed: boolean;
  syntax: LinkSyntax;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  headings: HeadingInfo[];
  tags: string[];
  blocks: BlockInfo[];
  links: ParsedLink[];
}

export interface RenderedNote extends ParsedNote {
  html: string;
}

export interface RenderTarget {
  targetFileId: string | null;
  targetPath: string | null;
  unresolved: boolean;
  ambiguous?: boolean;
  targetKind?: 'markdown' | 'attachment' | null;
  /** @deprecated Use targetKind. Retained for lightweight renderer adapters. */
  kind?: 'markdown' | 'attachment';
}

export interface MarkdownRenderOptions {
  markdown: string;
  sourcePath: string;
  vaultIndex?: VaultPathIndex;
  resolveLink?: (sourcePath: string, linkPath: string) => RenderTarget;
  attachmentUrl?: (fileId: string) => string;
}
