import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static guards for AnimateSwitch's PresenceGuard contract.
//
// We read the AnimateIn.tsx source from disk relative to this test file
// (the same way other tooling does) and assert the CodeRabbit-required
// invariants are present: useIsPresent is imported, and a wrapper div
// applies inert + aria-hidden = !isPresent around rendered children,
// while AnimatePresence keeps mode="wait" so outgoing and incoming
// panels do not mount simultaneously. Running this under the default
// "node" vitest environment avoids pulling in jsdom/@testing-library
// (which tripped Socket's obfuscated-code detector).
const __dirname = dirname(fileURLToPath(import.meta.url));
const animateInSrc = readFileSync(join(__dirname, "AnimateIn.tsx"), "utf8");

describe("AnimateSwitch PresenceGuard", () => {
  it("applies inert and aria-hidden via useIsPresent for exiting panels", () => {
    expect(animateInSrc).toContain("useIsPresent");
    // PresenceGuard renders inert/aria-hidden from !isPresent, so require the
    // negated expression exactly (not the positive isPresent form).
    expect(animateInSrc).toMatch(/inert=\{!isPresent\}/);
    expect(animateInSrc).toMatch(/aria-hidden=\{!isPresent\}/);
  });

  it("uses AnimatePresence with mode wait and initial=false", () => {
    expect(animateInSrc).toContain("AnimatePresence");
    // Accept both mode="wait" and mode={"wait"} spellings.
    expect(animateInSrc).toMatch(/mode=(?:"wait"|\{"wait"\})/);
    expect(animateInSrc).toContain("initial={false}");
  });

  it("wraps rendered children inside PresenceGuard inside the motion.div", () => {
    expect(animateInSrc).toContain("PresenceGuard");
    expect(animateInSrc).toContain("<PresenceGuard>{children}</PresenceGuard>");
  });
});
