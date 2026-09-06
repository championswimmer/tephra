export class SerializedReconciler {
  private running: Promise<void> | undefined;
  private requested = false;

  constructor(private readonly reconcile: () => Promise<void>) {}

  request(): Promise<void> {
    this.requested = true;
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        await this.reconcile();
      }
    } finally {
      this.running = undefined;
    }
  }
}
