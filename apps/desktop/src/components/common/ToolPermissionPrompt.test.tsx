// @vitest-environment jsdom
import type { ToolPermission } from "@maus-inc/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import de from "../../i18n/locales/de.json";

vi.mock("../../store", () => ({
  useAppStore: () => ({ description: "Read notes" }),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { ToolPermissionPrompt } from "./ToolPermissionPrompt";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
const onAllow = vi.fn();
const onDeny = vi.fn();
const onAlwaysAllow = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const mount = (
  variant: "default" | "overlay",
  params: Record<string, unknown>,
  status: ToolPermission["status"] = "pending",
) => {
  const permission: ToolPermission = {
    id: "permission",
    toolId: "read-notes",
    conversationId: "conversation",
    createdAt: 1,
    params,
    status,
  };
  act(() =>
    root.render(
      <IntlProvider locale="de" messages={de}>
        <ToolPermissionPrompt
          variant={variant}
          permission={permission}
          onAllow={onAllow}
          onDeny={onDeny}
          onAlwaysAllow={onAlwaysAllow}
        />
      </IntlProvider>,
    ),
  );
};

const render = (
  variant: "default" | "overlay",
  reason: unknown,
  status: ToolPermission["status"] = "pending",
) => mount(variant, { reason }, status);

/**
 * Render a permission that carries a risk tier.
 *
 * The tier rides in `params`, because `ToolPermission` is a persisted record
 * and a field cannot be added to it without a migration. These assertions are
 * what keep the tier from being decoration: each one fails if the prompt goes
 * back to treating a destructive action like a plain "Allow".
 */
const renderAtRisk = (risk: unknown) =>
  mount("default", { reason: "Because it is destructive", risk });

const buttonLabels = (): (string | null)[] =>
  Array.from(container.querySelectorAll("button")).map(
    (button) => button.textContent,
  );

describe("risk tiers reach the prompt", () => {
  it.each([
    ["low", () => de.reversible],
    ["medium", () => de.changes_something_on_your_screen],
    ["high", () => de.hard_to_undo],
    ["critical", () => de.can_destroy_what_you_have],
  ])("names the %s tier in plain language", (risk, label) => {
    renderAtRisk(risk);
    expect(container.textContent).toContain(label());
  });

  it("leaves a low or medium action offerable as a plain allow", () => {
    renderAtRisk("medium");
    expect(buttonLabels()).toEqual([de.deny, de.allow, de.always_allow]);
  });

  it("says it is confirming, not allowing, for a high tier", () => {
    renderAtRisk("high");
    expect(buttonLabels()).toEqual([
      de.deny,
      de.confirm_and_run,
      de.always_allow,
    ]);
  });

  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
  ])(
    "treats the prototype key %s as the worst tier, not as a tier at all",
    (risk) => {
      // `in` walks the prototype chain, so every one of these reads as a member
      // of the tier map. Seven of them then render a plain Allow with a
      // standing grant, and `__proto__` throws during render.
      renderAtRisk(risk);
      expect(buttonLabels()).toEqual([de.deny, de.confirm_and_run]);
      expect(container.textContent).toContain(de.can_destroy_what_you_have);
    },
  );

  it.each(["critical", "nonsense", 42, null, false, {}])(
    "withholds a standing grant and warns for the unreadable tier %s",
    (risk) => {
      // Anything carrying a value that is not one of the four tiers is treated
      // as the worst one. Reading it as a lesser tier is the direction that hands
      // an action the prompt cannot describe a permanent exemption.
      renderAtRisk(risk);
      expect(buttonLabels()).toEqual([de.deny, de.confirm_and_run]);
      expect(container.textContent).toContain(de.can_destroy_what_you_have);
      expect(container.textContent).toContain(
        de.this_one_cannot_be_taken_back_check_the_screen_before_you_co,
      );
    },
  );

  it("leaves a permission with no tier alone", () => {
    // Every permission raised before tool risk existed has no tier at all. It
    // must behave exactly as it did then, so an old record is neither upgraded
    // into a warning nor handed over with a standing grant.
    renderAtRisk(undefined);
    expect(buttonLabels()).toEqual([de.deny, de.allow, de.always_allow]);
    expect(container.textContent).not.toContain(de.confirm_and_run);
    expect(container.textContent).not.toContain(
      de.this_one_cannot_be_taken_back_check_the_screen_before_you_co,
    );
  });

  it("offers no standing grant and still allows a refusal", () => {
    renderAtRisk("critical");
    const [deny] = Array.from(container.querySelectorAll("button"));
    act(() => deny.click());
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

describe.each(["default", "overlay"] as const)(
  "%s tool permission",
  (variant) => {
    it.each([
      { reason: { message: "malformed reason" } },
      { reason: ["malformed reason"] },
      { reason: 42 },
      { reason: false },
      { reason: null },
      { reason: undefined },
    ])("ignores a non-string reason: $reason", ({ reason }) => {
      expect(() => render(variant, reason)).not.toThrow();
      expect(container.textContent).not.toContain("malformed reason");
      expect(container.textContent).not.toContain("42");
      expect(container.textContent).toContain("Read notes");
    });

    it("preserves the actual reason verbatim and wires each translated action once", () => {
      render(variant, "User supplied reason");
      expect(container.textContent).toContain("User supplied reason");
      const buttons = Array.from(container.querySelectorAll("button"));
      expect(buttons.map((button) => button.textContent)).toEqual([
        de.deny,
        de.allow,
        de.always_allow,
      ]);
      act(() => buttons.forEach((button) => button.click()));
      expect(onDeny).toHaveBeenCalledTimes(1);
      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
    });

    it.each(["allowed", "denied"] as const)(
      "does not offer actions once %s",
      (status) => {
        render(variant, "Because", status);
        expect(container.querySelector("button")).toBeNull();
        if (variant === "default") {
          expect(container.textContent).toContain(
            status === "allowed" ? "Erlaubt" : "Abgelehnt",
          );
        } else {
          expect(container.querySelector(".MuiChip-root")).toBeNull();
        }
      },
    );
  },
);
