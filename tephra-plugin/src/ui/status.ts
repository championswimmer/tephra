import type { SyncStatus } from '../sync/coordinator';

export class StatusDisplay {
  private current: SyncStatus = { phase: 'idle', message: 'Tephra idle.', at: Date.now() };

  constructor(private readonly element: HTMLElement) {
    this.render();
  }

  set(status: SyncStatus): void {
    this.current = status;
    this.render();
  }

  get(): SyncStatus {
    return this.current;
  }

  private render(): void {
    this.element.textContent = `Tephra: ${this.current.message}`;
    this.element.setAttribute('aria-label', this.current.message);
  }
}
