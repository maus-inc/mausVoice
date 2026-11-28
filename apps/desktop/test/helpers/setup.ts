import { config } from "dotenv";
import { resolve } from "path";
import { vi } from "vitest";

config({ path: resolve(__dirname, ".env") });

// Node's built-in localStorage is unusable without --localstorage-file,
// but zustand's persist middleware expects a working Storage implementation.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } satisfies Storage,
});

// Local-data writes are main-window-only. Vitest has no Tauri window metadata,
// so make that identity explicit without manufacturing a browser `window`
// object that would confuse DOM-dependent libraries in Node tests.
vi.mock("@tauri-apps/api/window", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tauri-apps/api/window")>();
  return {
    ...actual,
    getCurrentWindow: () =>
      ({
        label: "main",
      }) as ReturnType<typeof actual.getCurrentWindow>,
  };
});
