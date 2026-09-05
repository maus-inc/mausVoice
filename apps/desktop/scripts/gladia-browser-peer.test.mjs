import { describe, expect, it } from "vitest";
import { getGladiaBrowserPeer, isGladiaSdkModule } from "../vite.config";

describe("Gladia browser peer stubs", () => {
  it.each([
    ["ws", "ws"],
    ["ws/wrapper", "ws"],
    ["undici", "undici"],
    ["undici/lib/websocket", "undici"],
    ["fs/promises", "fs"],
    ["path/posix", "path"],
    ["node:fs", "fs"],
    ["node:fs/promises", "fs"],
    ["node:path", "path"],
    ["node:ws", "ws"],
  ])("maps %s to the %s browser stub", (source, peer) => {
    expect(getGladiaBrowserPeer(source)).toBe(peer);
  });

  it.each(["wss", "workspace", "undici-types", "node:crypto"])(
    "does not stub unrelated import %s",
    (source) => {
      expect(getGladiaBrowserPeer(source)).toBeUndefined();
    },
  );

  it.each([
    ["/repo/node_modules/@gladiaio/sdk/dist/client.js", true],
    [
      "/repo/node_modules/.pnpm/@gladiaio+sdk@1.1.0/node_modules/@gladiaio/sdk/dist/network/wsClient.js",
      true,
    ],
    ["/repo/node_modules/@gladiaio/sdk-extras/dist/index.js", false],
    ["/repo/apps/desktop/src/main.tsx", false],
    [undefined, false],
  ])("recognizes %s as an SDK importer: %s", (importer, expected) => {
    expect(isGladiaSdkModule(importer)).toBe(expected);
  });
});
