export type VaultEvent =
  | { type: 'create' | 'modify' | 'delete'; path: string }
  | { type: 'rename'; path: string; oldPath: string };

export class EventBuffer {
  private events = new Map<string, VaultEvent>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maximumTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly flushCallback: (events: VaultEvent[]) => void,
    private readonly debounceMs = 2_000,
    private readonly maximumMs = 10_000,
  ) {}

  add(event: VaultEvent): void {
    if (event.type === 'rename') this.events.delete(event.oldPath);
    const previous = this.events.get(event.path);
    const preservePrevious =
      (previous?.type === 'create' && event.type === 'modify') ||
      (previous?.type === 'rename' && event.type === 'modify');
    if (!preservePrevious) this.events.set(event.path, event);
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
    this.maximumTimer ??= setTimeout(() => this.flush(), this.maximumMs);
  }

  flush(): void {
    if (this.events.size === 0) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.maximumTimer !== undefined) clearTimeout(this.maximumTimer);
    this.debounceTimer = undefined;
    this.maximumTimer = undefined;
    const events = [...this.events.values()];
    this.events.clear();
    this.flushCallback(events);
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.maximumTimer !== undefined) clearTimeout(this.maximumTimer);
    this.events.clear();
  }
}
