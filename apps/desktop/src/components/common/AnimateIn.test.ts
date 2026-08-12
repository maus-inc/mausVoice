import { describe, expect, it } from "vitest";

// Static guard: PresenceGuard in AnimateIn.tsx applies `inert` and
// `aria-hidden` to outgoing panels via Framer Motion's `useIsPresent`
// hook so the exiting subtree cannot receive pointer/keyboard input
// during AnimatePresence transitions.
//
// We re-verify the runtime behavior indirectly here by asserting that:
//  1. the AnimateSwitch module exports a component whose JSX wraps its
//     children in a PresenceGuard div that toggles inert/aria-hidden
//     based on `useIsPresent()`;
//  2. the guard div is the *direct* parent of rendered children so an
//     outgoing panel cannot be interacted with until unmount.
//
// We do not spin up jsdom here (the existing vitest config targets the
// node environment) — instead we assert the source contains the guard
// contract. If someone removes the inert/aria-hidden wrapper, this
// test fails and the regression called out in the CodeRabbit review
// is caught before merge.
import fs from "node:fs";
import path from "node:path";

describe("AnimateSwitch PresenceGuard", () => {
  it("wraps children in a div that applies inert+aria-hidden from useIsPresent", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "AnimateIn.tsx"),
      "utf8",
    );
    expect(source).toContain("useIsPresent");
    expect(source).toMatch(/inert=\{!?isPresent\}/);
    expect(source).toMatch(/aria-hidden=\{!?isPresent\}/);
    expect(source).toContain("<PresenceGuard>{children}</PresenceGuard>");
  });

  it("uses AnimatePresence with mode='wait' so exactly one panel is present at a time", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "AnimateIn.tsx"),
      "utf8",
    );
    expect(source).toContain("AnimatePresence");
    expect(source).toMatch(/mode=\{?"wait"?\}/);
    expect(source).toMatch(/initial=\{?false\}?/);
  });
});
