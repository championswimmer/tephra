/** Runs async operations one at a time, in submission order, even after failures. */
export class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function serialized<T extends object>(repository: T, executor: SerialExecutor): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => executor.run(() => Reflect.apply(value, target, args) as Promise<unknown>);
    },
  });
}
