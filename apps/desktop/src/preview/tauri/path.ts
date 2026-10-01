const root = "preview://mausvoice";

// Every helper in `@tauri-apps/api/path` is promise-returning because it reads
// from the OS. These resolve synchronously behind a promise so callers can keep
// awaiting them unchanged.
export const appDataDir = (): Promise<string> =>
  Promise.resolve(`${root}/data`);
export const appLogDir = (): Promise<string> => Promise.resolve(`${root}/logs`);
export const appCacheDir = (): Promise<string> =>
  Promise.resolve(`${root}/cache`);
export const resourceDir = (): Promise<string> =>
  Promise.resolve(`${root}/resources`);
export const resolveResource = (resourcePath: string): Promise<string> =>
  Promise.resolve(`${root}/resources/${resourcePath}`);
export const join = (...paths: string[]): Promise<string> =>
  Promise.resolve(paths.filter(Boolean).join("/"));
export const basename = (path: string): Promise<string> =>
  Promise.resolve(path.split("/").reverse().find(Boolean) ?? "");
export const dirname = (path: string): Promise<string> =>
  Promise.resolve(path.split("/").slice(0, -1).join("/"));
