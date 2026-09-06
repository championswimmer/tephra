export interface BlobReadResult {
  bytes: ReadableStream<Uint8Array>;
  size: number;
  mimeType?: string;
}

export interface BlobStore {
  has(hash: string): Promise<boolean>;

  put(input: {
    hash: string;
    bytes: ReadableStream<Uint8Array> | Uint8Array;
    size: number;
    mimeType?: string;
  }): Promise<void>;

  get(hash: string): Promise<BlobReadResult | null>;

  delete(hash: string): Promise<void>;
}
