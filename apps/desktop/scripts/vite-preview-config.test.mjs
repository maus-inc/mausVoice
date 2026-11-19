import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("desktop Vite resolution", () => {
  it("keeps preview aliases and workspace conditions in the same config", async () => {
    const preview = await config({ command: "serve", mode: "preview" });
    expect(preview.resolve.alias["@tauri-apps/api/core"]).toBe(
      fileURLToPath(new URL("../src/preview/tauri/core.ts", import.meta.url)),
    );
    expect(preview.resolve.alias["@tauri-apps/plugin-http"]).toBe(
      fileURLToPath(new URL("../src/preview/tauri/http.ts", import.meta.url)),
    );
    expect(preview.resolve.conditions).toContain("browser");
    expect(preview.resolve.conditions).toContain("import");
  });

  it("never substitutes the native boundary in desktop builds", async () => {
    const desktop = await config({ command: "build", mode: "production" });
    expect(desktop.resolve.alias).toBeUndefined();
    expect(desktop.resolve.conditions).toContain("browser");
  });
});
