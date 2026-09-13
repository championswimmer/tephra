/**
 * Thin React shell around the imperative canvas renderer.
 *
 * Mounts `createGraphRenderer` once per `seed`, pushes every other prop
 * through `setModel` / `setSelected` via refs so prop churn never
 * re-creates the canvas. Callbacks are also read through refs so they stay
 * fresh without remounting.
 */

import { useEffect, useRef } from 'react';
import { createGraphRenderer } from '../renderer';
import type { GraphModel } from '../model';
import type { GraphPalette } from '../palette';
import type { GraphSettings } from '../settings';

export interface TephraGraphProps {
  model: GraphModel;
  settings: GraphSettings;
  groupColors: Array<string | null>;
  palette: GraphPalette;
  selectedId: string | null;
  seed: number;
  /** Bumping this reheats the settled simulation (Animate button). Starts at 0 = never. */
  animateToken?: number | undefined;
  onNodeClick?: ((id: string) => void) | undefined;
  onNodeHover?: ((id: string | null) => void) | undefined;
  onReady?: (() => void) | undefined;
}

export function TephraGraph({
  model,
  settings,
  groupColors,
  palette,
  selectedId,
  seed,
  animateToken = 0,
  onNodeClick,
  onNodeHover,
  onReady,
}: TephraGraphProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  const propsRef = useRef({ model, settings, groupColors, palette });
  propsRef.current = { model, settings, groupColors, palette };
  const callbacksRef = useRef({ onNodeClick, onNodeHover, onReady });
  callbacksRef.current = { onNodeClick, onNodeHover, onReady };
  const rendererRef = useRef<ReturnType<typeof createGraphRenderer> | null>(null);

  // Mount the imperative renderer once per seed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = createGraphRenderer(host, {
      seed,
      onNodeClick: (id) => callbacksRef.current.onNodeClick?.(id),
      onNodeHover: (id) => callbacksRef.current.onNodeHover?.(id),
      onReady: () => callbacksRef.current.onReady?.(),
    });
    rendererRef.current = renderer;
    const initial = propsRef.current;
    renderer.setModel(
      initial.model,
      initial.groupColors,
      initial.palette,
      initial.settings,
    );
    return () => {
      rendererRef.current = null;
      renderer.destroy();
    };
  }, [seed]);

  // Push model / visual props without remounting.
  useEffect(() => {
    rendererRef.current?.setModel(model, groupColors, palette, settings);
  }, [model, groupColors, palette, settings]);

  // Push selection without remounting.
  useEffect(() => {
    rendererRef.current?.setSelected(selectedId);
  }, [selectedId]);

  // On-demand animation: the mount effect's initial setModel draws
  // statically, so ignore the initial token and only animate on bumps.
  useEffect(() => {
    if (animateToken > 0) rendererRef.current?.animate();
  }, [animateToken]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
