// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Conversation } from "@maus-inc/types";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import en from "../../i18n/locales/en.json";
import { ConversationListItem } from "./ConversationListItem";
ensureUiHarness();
const conversation = {
  id: "c",
  title: "A thread",
  createdAt: "2026-08-01T12:00:00Z",
  updatedAt: "2026-08-01T12:00:00Z",
} as Conversation;
it("makes selection and its named options separate keyboard controls", async () => {
  const onSelect = vi.fn(),
    onDelete = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <IntlProvider locale="en" messages={en}>
            <ConversationListItem
              conversation={conversation}
              selected={false}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          </IntlProvider>
        </MemoryRouter>,
      ),
    );
    const select = host.querySelector<HTMLElement>('[role="button"]')!;
    const options = host.querySelector<HTMLButtonElement>(
      'button[aria-label="More options for A thread"]',
    )!;
    expect(select.contains(options)).toBe(false);
    expect(options.getAttribute("aria-haspopup")).toBe("menu");
    expect(options.getAttribute("aria-expanded")).toBe("false");
    await act(async () => options.click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(options.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
