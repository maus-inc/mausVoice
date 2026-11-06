// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useIntervalAsync } from "./helper.hooks";

describe("useIntervalAsync rejection handling", () => {
  // `tick` runs on mount and again from `setInterval`, and neither call site
  // awaits. A rejecting callback therefore escaped as an unhandled rejection --
  // on mount, then once per interval. That is reachable in production: the
  // session heartbeat awaits a Firebase write that rejects when the backend
  // refuses, while the identical write a few lines above it in the same file
  // already carried a `.catch`.
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("does not let a rejecting callback escape unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const Probe = () => {
        useIntervalAsync(
          60_000,
          () => Promise.reject(new Error("PERMISSION_DENIED: heartbeat")),
          [],
        );
        return null;
      };
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(Probe));
      });
      // Let the mount tick's rejection settle, and give the runtime a turn to
      // report it if it were going to.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await act(async () => {
        root.unmount();
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
