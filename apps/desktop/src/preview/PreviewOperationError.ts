/**
 * The error the browser preview raises for anything it cannot honestly fake.
 *
 * It lives in its own module, with no imports, because the low-level Tauri stubs
 * under `preview/tauri/` stand in for leaf dependencies that much of the app
 * imports. `http.ts` needs this class, and reaching it through `runtime.ts`
 * would drag the store, the router and the whole page tree into the graph of
 * every module that imports `@tauri-apps/plugin-http`. Keeping the class
 * dependency-free means a stub can raise it without importing the app.
 *
 * `runtime.ts` re-exports it, so app code and the runtime's own tests keep one
 * import path and `instanceof` keeps working across both.
 */
export class PreviewOperationError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(
      `“${command}” is unavailable in the browser preview. It requires the native mausVoice desktop app.`,
    );
    this.name = "PreviewOperationError";
    this.command = command;
  }
}
