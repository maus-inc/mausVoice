import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { vendorManualChunk } from "./vendor-manual-chunk.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("vendorManualChunk", () => {
  it("keeps React and react-intl in the same chunk", () => {
    const reactId =
      "/repo/node_modules/.pnpm/react@19.2.8/node_modules/react/index.js";
    const intlId =
      "/repo/node_modules/.pnpm/react-intl@7.1.14/node_modules/react-intl/lib/src/components/message.js";
    const formatjsId =
      "/repo/node_modules/.pnpm/@formatjs+intl@3.1.6/node_modules/@formatjs/intl/lib/src/error.js";

    expect(vendorManualChunk(reactId)).toBe("react");
    expect(vendorManualChunk(intlId)).toBe("react");
    expect(vendorManualChunk(formatjsId)).toBe("react");
    expect(vendorManualChunk(intlId)).toBe(vendorManualChunk(reactId));
  });

  it("normalizes Windows paths before matching", () => {
    expect(
      vendorManualChunk(
        "C:\\repo\\node_modules\\react-intl\\lib\\src\\index.js",
      ),
    ).toBe("react");
  });

  it("does not emit a separate intl chunk", () => {
    expect(
      vendorManualChunk("/repo/node_modules/intl-messageformat/lib/index.js"),
    ).toBe("react");
  });

  it("leaves app source unchunked and still splits unrelated vendors", () => {
    expect(
      vendorManualChunk("/repo/apps/desktop/src/main.tsx"),
    ).toBeUndefined();
    expect(
      vendorManualChunk("/repo/node_modules/firebase/app/dist/index.js"),
    ).toBe("firebase");
    expect(vendorManualChunk("/repo/node_modules/@mui/material/index.js")).toBe(
      "mui",
    );
  });
});

describe("vite.config.ts chunk wiring", () => {
  it("uses vendorManualChunk and never assigns an intl chunk", () => {
    const source = readFileSync(resolve(here, "../vite.config.ts"), "utf8");
    expect(source).toContain("vendorManualChunk");
    expect(source).not.toMatch(/return\s+["']intl["']/);
  });
});
