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
const render = (
  variant: "default" | "overlay",
  reason: unknown,
  status: ToolPermission["status"] = "pending",
) => {
  const permission: ToolPermission = {
    id: "permission",
    toolId: "read-notes",
    conversationId: "conversation",
    createdAt: 1,
    params: { reason },
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
