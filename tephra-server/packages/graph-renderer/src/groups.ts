import type { GraphModel } from './model';
import { matchesQuery, parseQuery } from './query';
import type { ColorGroup } from './settings';

/**
 * Resolve group colors per node: first matching group query wins
 * (same engine as the Filters search box). Returns a color hex per node
 * index, or null when no group matches.
 */
export function resolveGroupColors(model: GraphModel, groups: ColorGroup[]): Array<string | null> {
  if (groups.length === 0) return model.nodes.map(() => null);
  const parsed = groups.map((group) => parseQuery(group.query));
  return model.nodes.map((node) => {
    for (let index = 0; index < groups.length; index += 1)
      if (!parsed[index]!.empty && matchesQuery(node, parsed[index]!)) return groups[index]!.color;
    return null;
  });
}
