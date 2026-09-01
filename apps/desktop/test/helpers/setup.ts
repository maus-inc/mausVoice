import { config } from "dotenv";
import { resolve } from "path";

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
