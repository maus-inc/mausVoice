// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import de from "../../i18n/locales/de.json";
import en from "../../i18n/locales/en.json";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { DashboardMenu } from "./DashboardMenu";

const renderMenu = (path: string, locale: "en" | "de" = "en") => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <IntlProvider locale={locale} messages={locale === "de" ? de : en}>
      <MemoryRouter initialEntries={[path]}>
        <DashboardMenu />
      </MemoryRouter>
    </IntlProvider>,
  );
  return container;
};

const expectCurrentTile = (
  menu: HTMLDivElement,
  labels: {
    navigation: string;
    pages: string;
    settings: string;
    current: string;
  },
) => {
  const nav = menu.querySelector(`nav[aria-label="${labels.navigation}"]`);
  expect(nav).not.toBeNull();
  const pages = nav?.querySelector(`ul[aria-label="${labels.pages}"]`);
  const settings = nav?.querySelector(`ul[aria-label="${labels.settings}"]`);
  expect(pages?.querySelectorAll(":scope > li")).toHaveLength(5);
  expect(settings?.querySelectorAll(":scope > li")).toHaveLength(1);

  // Locate the destination first: aria-current belongs on its tile, not the
  // nav or list ancestor (whose text also contains every destination label).
  const tiles = nav?.querySelectorAll("ul > li .MuiListItemButton-root");
  const currentTile = Array.from(tiles ?? []).find((tile) =>
    tile.textContent?.includes(labels.current),
  );
  expect(currentTile, `${labels.current} tile must exist`).toBeDefined();
  expect(currentTile?.getAttribute("aria-current")).toBe("page");
  expect(nav?.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
};

describe("DashboardMenu accessibility", () => {
  it.each([
    ["/dashboard", "Home"],
    ["/dashboard/dictionary", "Dictionary"],
    ["/dashboard/transcriptions", "History"],
    ["/dashboard/settings", "Settings"],
  ])("announces %s as the current page", (path, label) => {
    expectCurrentTile(renderMenu(path), {
      navigation: en.dashboard_navigation,
      pages: en.pages,
      settings: en.settings,
      current: label,
    });
  });

  it("resolves navigation labels and destinations from the German catalog", () => {
    expectCurrentTile(renderMenu("/dashboard/dictionary", "de"), {
      navigation: de.dashboard_navigation,
      pages: de.pages,
      settings: de.settings,
      current: de.dictionary,
    });
  });
});
