/**
 * Main-thread driver for the force simulation (plan 011 §7).
 *
 * Prefers the module worker; when `Worker` construction fails (old browser,
 * CSP without worker-src, test environments) the identical {@link ForceEngine}
 * runs on the main thread behind the same interface. Callers always recycle
 * position buffers via `releasePositions` so the worker path stays at zero
 * steady-state allocation; the fallback path reuses a single buffer.
 */
import { ForceEngine, remapPositions, type EngineGraphInput, type ForceParameters } from './simulation';
import type { WorkerInMessage, WorkerOutMessage } from './simulation.worker';

export interface SimulationHostEvents {
  /** Positions for the current graph; the array must not be retained. */
  onPositions: (positions: Float32Array) => void;
  onSettled?: () => void;
}

export interface SimulationHost {
  readonly workerBacked: boolean;
  setGraph: (graph: EngineGraphInput, forces: ForceParameters) => void;
  /** Swap to a filtered graph, keeping positions of surviving nodes. */
  setFilteredGraph: (
    graph: Omit<EngineGraphInput, 'initialPositions'>,
    forces: ForceParameters,
    oldToNew: Int32Array,
    previous: Float32Array,
  ) => void;
  setForces: (forces: ForceParameters) => void;
  pin: (index: number, x: number, y: number) => void;
  unpin: (index: number) => void;
  reheat: () => void;
  destroy: () => void;
}

function postToWorker(worker: Worker, message: WorkerInMessage, transfer?: Transferable[]): void {
  worker.postMessage(message, transfer ?? []);
}

export function createSimulationHost(events: SimulationHostEvents): SimulationHost {
  let worker: Worker | null = null;
  try {
    if (typeof Worker !== 'undefined')
      worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (worker) {
    const active = worker;
    active.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      if (message.type === 'positions') {
        events.onPositions(message.positions);
        // Hand the buffer back for reuse on the next frame.
        postToWorker(active, { type: 'recycle', buffer: message.positions.buffer }, [
          message.positions.buffer,
        ]);
      } else {
        events.onSettled?.();
      }
    };
    return {
      workerBacked: true,
      setGraph: (graph, forces) => postToWorker(active, { type: 'setGraph', graph, forces }),
      setFilteredGraph: (graph, forces, oldToNew, previous) =>
        postToWorker(active, {
          type: 'setGraph',
          graph: { ...graph, initialPositions: remapPositions(previous, oldToNew, graph.nodeCount) },
          forces,
        }),
      setForces: (forces) => postToWorker(active, { type: 'setForces', forces }),
      pin: (index, x, y) => postToWorker(active, { type: 'pin', index, x, y }),
      unpin: (index) => postToWorker(active, { type: 'unpin', index }),
      reheat: () => postToWorker(active, { type: 'reheat' }),
      destroy: () => active.terminate(),
    };
  }

  // Main-thread fallback: the same engine, driven by a timer, writing into
  // one reused buffer (no transfer involved).
  const engine = new ForceEngine();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let buffer = new Float32Array(0);
  let framePending = false;

  const frame = () => {
    timer = null;
    framePending = false;
    const more = engine.tick();
    engine.readPositions(buffer);
    events.onPositions(buffer);
    if (more) schedule();
    else events.onSettled?.();
  };
  const schedule = () => {
    if (framePending) return;
    framePending = true;
    timer = setTimeout(frame, 16);
  };
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    framePending = false;
  };

  return {
    workerBacked: false,
    setGraph: (graph, forces) => {
      cancel();
      buffer = new Float32Array(graph.nodeCount * 2);
      engine.setForces(forces);
      engine.setGraph(graph);
      schedule();
    },
    setFilteredGraph: (graph, forces, oldToNew, previous) => {
      cancel();
      buffer = remapPositions(previous, oldToNew, graph.nodeCount);
      engine.setForces(forces);
      engine.setGraph({ ...graph, initialPositions: buffer });
      schedule();
    },
    setForces: (forces) => {
      engine.setForces(forces);
      engine.reheat();
      schedule();
    },
    pin: (index, x, y) => {
      engine.pin(index, x, y);
      schedule();
    },
    unpin: (index) => {
      engine.unpin(index);
      schedule();
    },
    reheat: () => {
      engine.reheat();
      schedule();
    },
    destroy: () => cancel(),
  };
}
