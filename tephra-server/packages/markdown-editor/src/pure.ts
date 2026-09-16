/**
 * Framework-free logic for the markdown editor: conflict decisions shared by
 * the web client and (logically) the plugin. No DOM, no CodeMirror — import
 * from `@tephra/markdown-editor/pure` when the editor bundle must stay out.
 */

export type ConflictOutcome = 'remote-wins' | 'local-wins' | 'identical';

export interface ConflictInput {
  localHash: string;
  localMtime: number;
  remoteHash: string;
  remoteMtime: number;
}

/**
 * Last-write-wins conflict decision. Equal hashes mean the sides converged
 * independently, so there is nothing to resolve. Otherwise the newer mtime
 * wins; exact ties resolve local because the local vault is the declared
 * source of truth and browser/desktop clock skew is the likeliest cause of
 * a tie.
 */
export function resolveConflict(input: ConflictInput): ConflictOutcome {
  if (input.localHash === input.remoteHash) return 'identical';
  if (input.remoteMtime > input.localMtime) return 'remote-wins';
  return 'local-wins';
}
