const root = "preview://mausvoice";

export const appDataDir = async (): Promise<string> => `${root}/data`;
export const appLogDir = async (): Promise<string> => `${root}/logs`;
export const appCacheDir = async (): Promise<string> => `${root}/cache`;
export const resourceDir = async (): Promise<string> => `${root}/resources`;
export const resolveResource = async (resourcePath: string): Promise<string> =>
  `${root}/resources/${resourcePath}`;
export const join = async (...paths: string[]): Promise<string> =>
  paths.filter(Boolean).join("/");
export const basename = async (path: string): Promise<string> =>
  path.split("/").filter(Boolean).at(-1) ?? "";
export const dirname = async (path: string): Promise<string> =>
  path.split("/").slice(0, -1).join("/");
