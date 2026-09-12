import { readFileSync } from "node:fs";

export const AUTOMATION_APP_ID = "com.mausinc.desktop";
export const AUTOMATION_FILE_NAME = "automation-api.json";
export const AUTOMATION_DEFAULT_PORT = 37291;
export const AUTOMATION_TOKEN_ENV = "MAUSVOICE_AUTOMATION_TOKEN";

export type AutomationConnection = {
  baseUrl: string;
  token: string;
};

export type ConnectionOptions = {
  port?: number;
  token?: string;
  configFile?: string;
  platform?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
};

const configFileFor = (
  platform: string,
  env: Record<string, string | undefined>,
  homeDir: string,
): string => {
  const sep = platform === "win32" ? "\\" : "/";
  if (platform === "win32") {
    const base = env["APPDATA"] ?? `${homeDir}${sep}AppData${sep}Roaming`;
    return `${base}${sep}${AUTOMATION_APP_ID}${sep}${AUTOMATION_FILE_NAME}`;
  }
  if (platform === "darwin") {
    return `${homeDir}${sep}Library${sep}Application Support${sep}${AUTOMATION_APP_ID}${sep}${AUTOMATION_FILE_NAME}`;
  }
  const base = env["XDG_CONFIG_HOME"] ?? `${homeDir}${sep}.config`;
  return `${base}${sep}${AUTOMATION_APP_ID}${sep}${AUTOMATION_FILE_NAME}`;
};

type ConnectionFile = {
  port?: unknown;
  token?: unknown;
};

const readConnectionFile = (path: string): ConnectionFile => {
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid automation connection file: ${path}`);
  }
  return parsed as ConnectionFile;
};

export const resolveConnection = (
  options: ConnectionOptions = {},
): AutomationConnection => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir =
    options.homeDir ??
    env["HOME"] ??
    env["USERPROFILE"] ??
    (platform === "win32" ? "C:\\Users\\Default" : "/root");

  const readTokenFromFile = (): string => {
    const path = options.configFile ?? configFileFor(platform, env, homeDir);
    try {
      const file = readConnectionFile(path);
      if (typeof file.token === "string" && file.token) {
        return file.token;
      }
    } catch {
      // Fall through to the not-running error below.
    }
    throw new Error(
      "No automation token: start the mausVoice desktop app or pass --token (or MAUSVOICE_AUTOMATION_TOKEN).",
    );
  };

  const readPortFromFile = (): number | undefined => {
    const path = options.configFile ?? configFileFor(platform, env, homeDir);
    try {
      const file = readConnectionFile(path);
      if (typeof file.port === "number" && Number.isInteger(file.port)) {
        return file.port;
      }
    } catch {
      // Fall through to the default below.
    }
    return undefined;
  };

  const token =
    options.token ?? env[AUTOMATION_TOKEN_ENV] ?? readTokenFromFile();
  const port = options.port ?? readPortFromFile() ?? AUTOMATION_DEFAULT_PORT;
  return { baseUrl: `http://127.0.0.1:${port}`, token };
};

export const connectionFilePath = (
  options: Pick<ConnectionOptions, "platform" | "env" | "homeDir"> = {},
): string => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir =
    options.homeDir ??
    env["HOME"] ??
    env["USERPROFILE"] ??
    (platform === "win32" ? "C:\\Users\\Default" : "/root");
  return configFileFor(platform, env, homeDir);
};
