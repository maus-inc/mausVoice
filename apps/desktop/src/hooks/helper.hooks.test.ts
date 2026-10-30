// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalizeKey, KEY_ALIASES, useIntervalAsync } from "./helper.hooks";

describe("canonicalizeKey / KEY_ALIASES precedence", () => {
  it('maps a raw Space " " to "space"', () => {
    expect(canonicalizeKey(" ")).toBe("space");
    expect(KEY_ALIASES[" "]).toBe("space");
  });

  it("resolves synonyms regardless of case", () => {
    expect(canonicalizeKey("ESC")).toBe("escape");
    expect(canonicalizeKey("esc")).toBe("escape");
    expect(canonicalizeKey("RETURN")).toBe("enter");
    expect(canonicalizeKey("Enter")).toBe("enter");
    expect(canonicalizeKey("Up")).toBe("arrowup");
    expect(canonicalizeKey("Left")).toBe("arrowleft");
  });

  it("prefers the raw key over the trimmed key (precedence)", () => {
    // The raw " " (single space, as KeyboardEvent.key reports Space) resolves
    // through the alias table via the raw branch, not the trimmed branch.
    expect(canonicalizeKey(" ")).toBe(KEY_ALIASES[" "]);
    expect(KEY_ALIASES[" "]).toBe("space");
  });

  it("falls back to the trimmed key when the raw key is not an alias", () => {
    // raw "  space  " is not a key, but the trimmed "space" is.
    expect(canonicalizeKey("  space  ")).toBe("space");
  });

  it("returns the trimmed token for unknown keys", () => {
    expect(canonicalizeKey("  aBc  ")).toBe("abc");
    expect(canonicalizeKey("é")).toBe("é");
  });
});

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
