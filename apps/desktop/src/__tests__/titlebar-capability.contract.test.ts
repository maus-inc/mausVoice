import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// `here` is <repo>/apps/desktop/src/__tests__, so the app root is two levels up.
const desktopRoot = resolve(here, "..", "..");

type Capability = {
  permissions: Array<string | { identifier: string }>;
};

const readCapability = (): Capability =>
  JSON.parse(
    readFileSync(
      resolve(desktopRoot, "src-tauri/capabilities/default.json"),
      "utf8",
    ),
  ) as Capability;

const grantedPermissions = (capability: Capability): Set<string> =>
  new Set(
    capability.permissions.map((entry) =>
      typeof entry === "string" ? entry : entry.identifier,
    ),
  );

/**
 * Window API calls the title bar makes, and the capability each one needs.
 *
 * Tauri denies a command the capability does not list, and the rejection is
 * only visible as a snackbar at runtime, so a missing grant looks like a title
 * bar that quietly does nothing on one platform. `core:default` covers the
 * read-only calls (position, size, scale factor, monitor, cursor) but none of
 * the commands that change the window, which is why each of those is named
 * here.
 */
const REQUIRED_GRANTS: Array<{ call: string; permission: string }> = [
  { call: "startDragging", permission: "core:window:allow-start-dragging" },
  { call: "minimize", permission: "core:window:allow-minimize" },
  { call: "maximize", permission: "core:window:allow-maximize" },
  { call: "unmaximize", permission: "core:window:allow-unmaximize" },
  { call: "setPosition", permission: "core:window:allow-set-position" },
  { call: "close", permission: "core:window:allow-close" },
];

describe("title bar window capability contract", () => {
  it("grants every window command the title bar invokes", () => {
    const granted = grantedPermissions(readCapability());
    const missing = REQUIRED_GRANTS.filter(
      (entry) => !granted.has(entry.permission),
    ).map((entry) => `${entry.call} needs ${entry.permission}`);

    expect(missing).toEqual([]);
  });

  it("names window commands one at a time rather than granting the plugin whole", () => {
    // A wildcard would also grant the commands this app never calls, and the
    // point of listing them is that each one was a decision.
    const wildcards = [...grantedPermissions(readCapability())].filter(
      (entry) => entry.startsWith("core:window:*"),
    );

    expect(wildcards).toEqual([]);
  });
});
