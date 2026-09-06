export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}

export async function requestUrl(): Promise<never> {
  throw new Error('Obsidian requestUrl was not mocked by this test.');
}
