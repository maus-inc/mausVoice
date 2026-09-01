import { describe, expect, it } from "vitest";
import { getGladiaBrowserPeer } from "../vite.config";

describe("Gladia browser peer stubs", () => {
  it.each([
    ["ws", "ws"],
    ["ws/wrapper", "ws"],
    ["undici", "undici"],
    ["undici/lib/websocket", "undici"],
    ["fs/promises", "fs"],
    ["path/posix", "path"],
  ])("maps %s to the %s browser stub", (source, peer) => {
    expect(getGladiaBrowserPeer(source)).toBe(peer);
  });

  it.each(["wss", "workspace", "undici-types", "node:fs"])(
    "does not stub unrelated import %s",
    (source) => {
      expect(getGladiaBrowserPeer(source)).toBeUndefined();
    },
  );
});
