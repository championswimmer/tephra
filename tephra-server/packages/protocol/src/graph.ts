import { z } from 'zod';
import { nonNegativeIntegerSchema } from './primitives.js';

export const graphNodeKindSchema = z.enum(['note', 'attachment', 'tag', 'unresolved']);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

export const graphNodeSchema = z.strictObject({
  // File id for note/attachment nodes; `tag:<name>` / `unresolved:<path>`
  // for synthesized nodes, so this is intentionally wider than identifierSchema.
  id: z.string().min(1).max(1024),
  // Canonical vault path for files; the tag name for tag nodes; the
  // normalized raw link path for unresolved nodes.
  path: z.string().min(1).max(1024),
  title: z.string().nullable(),
  kind: graphNodeKindSchema,
  // Tags carried by note nodes; empty for every other kind.
  tags: z.array(z.string().min(1).max(200)).max(100),
  // Creation-order timestamp (the synced mtime for files, the oldest
  // source note's value for synthesized nodes). Retained on the payload
  // for ordering; the client no longer animates over it.
  createdAt: nonNegativeIntegerSchema,
});
export type GraphNodeDto = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.strictObject({
  // Array indices into `nodes` (not id strings): at ~30k edges this is the
  // difference between a ~2.5 MB and a ~600 KB payload.
  s: nonNegativeIntegerSchema,
  t: nonNegativeIntegerSchema,
  count: z.number().int().positive().safe(),
  embeds: nonNegativeIntegerSchema,
});
export type GraphEdgeDto = z.infer<typeof graphEdgeSchema>;

export const graphResponseSchema = z
  .strictObject({
    revision: nonNegativeIntegerSchema,
    // True when the 10k node cap was hit and the graph was trimmed.
    truncated: z.boolean(),
    // True while the indexer has not caught up with `revision` yet.
    indexPending: z.boolean().optional(),
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
  })
  .superRefine((value, context) => {
    value.edges.forEach((edge, index) => {
      if (edge.s >= value.nodes.length || edge.t >= value.nodes.length) {
        context.addIssue({
          code: 'custom',
          message: 'Graph edge endpoint index is out of range.',
          path: ['edges', index],
        });
      }
    });
  });
export type GraphResponse = z.infer<typeof graphResponseSchema>;
