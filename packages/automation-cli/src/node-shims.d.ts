declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
  platform: "win32" | "darwin" | "linux" | string;
  stdin: unknown;
  stdout: { write: (chunk: string) => void };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:readline" {
  export function createInterface(options: { input: unknown }): {
    on: (event: "line" | "close", listener: (line: string) => void) => void;
  };
}
