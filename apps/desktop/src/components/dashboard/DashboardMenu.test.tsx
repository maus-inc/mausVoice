// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { DashboardMenu } from "./DashboardMenu";

const renderMenu = (path: string) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <IntlProvider locale="en">
      <MemoryRouter initialEntries={[path]}>
        <DashboardMenu />
      </MemoryRouter>
    </IntlProvider>,
  );
  return container;
};

describe("DashboardMenu accessibility", () => {
  it.each([
    ["/dashboard", "Home"],
    ["/dashboard/dictionary", "Dictionary"],
    ["/dashboard/transcriptions", "History"],
    ["/dashboard/settings", "Settings"],
  ])("announces %s as the current page", (path, label) => {
    const menu = renderMenu(path);
    const nav = menu.querySelector('nav[aria-label="Dashboard navigation"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelector('ul[aria-label="Pages"]')).not.toBeNull();
    const current = nav?.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current?.[0]?.textContent).toContain(label);
  });
});
