/**
 * Module worker entry point (plan 011 §7): owns a {@link ForceEngine} and
 * streams positions to the main thread. Loaded via
 * `new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })`.
 */
/// <reference lib="webworker" />
import { ForceEngine, type EngineGraphInput, type ForceParameters } from './simulation';

export type WorkerInMessage =
  | { type: 'setGraph'; graph: EngineGraphInput; forces: ForceParameters }
  | { type: 'setForces'; forces: ForceParameters }
  | { type: 'pin'; index: number; x: number; y: number }
  | { type: 'unpin'; index: number }
  | { type: 'reheat'; alpha?: number }
  | { type: 'stop' }
  | { type: 'recycle'; buffer: ArrayBuffer };

export type WorkerOutMessage =
  | { type: 'positions'; positions: Float32Array<ArrayBuffer> }
  | { type: 'settled' };

const engine = new ForceEngine();
// Buffers returned by the main thread for zero-allocation reuse.
const freeBuffers: Float32Array<ArrayBuffer>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let framePending = false;

function frame() {
  timer = null;
  framePending = false;
  const more = engine.tick();
  const out = freeBuffers.pop() ?? new Float32Array(engine.nodeCount * 2);
  if (out.length < engine.nodeCount * 2) {
    // A recycled buffer from a smaller graph; replace it.
    freeBuffers.length = 0;
    const fresh = new Float32Array(engine.nodeCount * 2);
    engine.readPositions(fresh);
    postMessage({ type: 'positions', positions: fresh } satisfies WorkerOutMessage, [fresh.buffer]);
  } else {
    engine.readPositions(out);
    postMessage({ type: 'positions', positions: out } satisfies WorkerOutMessage, [out.buffer]);
  }
  if (more) schedule();
  else postMessage({ type: 'settled' } satisfies WorkerOutMessage);
}

function schedule() {
  if (framePending) return;
  framePending = true;
  timer = setTimeout(frame, 16);
}

function cancel() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  framePending = false;
}

onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'setGraph':
      cancel();
      engine.setForces(message.forces);
      engine.setGraph(message.graph);
      schedule();
      break;
    case 'setForces':
      engine.setForces(message.forces);
      engine.reheat();
      schedule();
      break;
    case 'pin':
      engine.pin(message.index, message.x, message.y);
      schedule();
      break;
    case 'unpin':
      engine.unpin(message.index);
      schedule();
      break;
    case 'reheat':
      engine.reheat(message.alpha);
      schedule();
      break;
    case 'stop':
      cancel();
      engine.stop();
      break;
    case 'recycle':
      if (message.buffer.byteLength > 0 && freeBuffers.length < 2)
        freeBuffers.push(new Float32Array(message.buffer));
      break;
  }
};
