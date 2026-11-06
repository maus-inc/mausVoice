// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRouterModel } from "@maus-inc/types";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  load: vi.fn().mockResolvedValue(undefined),
  favorite: vi.fn().mockResolvedValue(undefined),
  search: vi.fn(),
  config: vi.fn(),
}));
vi.mock("../../actions/openrouter.actions", () => ({
  getOpenRouterConfigForKey: mocks.config,
  loadOpenRouterModels: mocks.load,
  setOpenRouterSearchQuery: mocks.search,
  toggleOpenRouterFavoriteModel: mocks.favorite,
}));
vi.mock("../../store", () => ({
  useAppStore: (selector: (state: typeof fakeState) => unknown) =>
    selector(fakeState),
}));
vi.mock("react-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-intl")>()),
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));
import { OpenRouterModelPicker } from "./OpenRouterModelPicker";

ensureUiHarness();
const models: OpenRouterModel[] = [
  {
    id: "alpha/model",
    name: "Alpha",
    context_length: 4096,
    pricing: { prompt: "0", completion: "0" },
  },
  {
    id: "beta/model",
    name: "Beta",
    context_length: 4096,
    pricing: { prompt: "0", completion: "0" },
  },
];
let fakeState = {
  settings: {
    openRouterModels: models,
    openRouterModelsStatus: "success",
    openRouterSearchQuery: "",
  },
};

describe("OpenRouterModelPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let select: ReturnType<typeof vi.fn>;
  const render = async (disabled = false) => {
    await act(async () =>
      root.render(
        <OpenRouterModelPicker
          apiKeyId="key"
          selectedModel="beta/model"
          onModelSelect={select}
          disabled={disabled}
        />,
      ),
    );
  };
  beforeEach(() => {
    fakeState = {
      settings: {
        openRouterModels: models,
        openRouterModelsStatus: "success",
        openRouterSearchQuery: "",
      },
    };
    vi.clearAllMocks();
    mocks.config.mockReturnValue({ favoriteModels: ["alpha/model"] });
    select = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows favorites, selects a model, and resets the search on collapse", async () => {
    await render();
    expect(container.textContent).toContain("Beta");
    await act(async () =>
      container.querySelector<HTMLElement>(".MuiPaper-root")!.click(),
    );
    expect(container.textContent).toContain("Favorites");
    expect(container.textContent).toContain("All Models");
    const alpha = [
      ...container.querySelectorAll<HTMLElement>(".MuiTypography-root"),
    ].find((node) => node.textContent === "Alpha")!;
    await act(async () => alpha.click());
    expect(select).toHaveBeenCalledExactlyOnceWith("alpha/model");
    expect(mocks.search).toHaveBeenCalledWith("");
    expect(
      container.querySelector('input[placeholder="Search models..."]'),
    ).toBeNull();
  });

  it("toggles a favorite without selecting the model", async () => {
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>('[role="button"]')!.click(),
    );
    const favorite = container
      .querySelector<HTMLElement>('[data-testid="StarIcon"]')!
      .closest("button")!;
    await act(async () => favorite.click());
    expect(mocks.favorite).toHaveBeenCalledExactlyOnceWith(
      "key",
      "alpha/model",
    );
    expect(select).not.toHaveBeenCalled();
    expect(
      container.querySelector('input[placeholder="Search models..."]'),
    ).not.toBeNull();
  });

  it("loads idle models on expansion and not while collapsed", async () => {
    fakeState.settings.openRouterModelsStatus = "idle";
    await render();
    expect(mocks.load).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLElement>('[role="button"]')!.click(),
    );
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("opens from the keyboard and exposes its disabled state", async () => {
    await render();
    const control = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(control).not.toBeNull();
    expect(control.tabIndex).toBe(0);
    await act(async () =>
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(
      container.querySelector('input[placeholder="Search models..."]'),
    ).not.toBeNull();
  });

  it("ignores surrounding spaces when filtering model names", async () => {
    fakeState.settings.openRouterSearchQuery = "  aLpHa  ";
    await render();
    await act(async () =>
      container.querySelector<HTMLElement>('[role="button"]')!.click(),
    );
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).not.toContain("Beta");
  });

  it("does not expand a disabled picker", async () => {
    await render(true);
    const control = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(control.tabIndex).toBe(-1);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    await act(async () =>
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      ),
    );
    await act(async () =>
      container.querySelector<HTMLElement>(".MuiPaper-root")!.click(),
    );
    expect(
      container.querySelector('input[placeholder="Search models..."]'),
    ).toBeNull();
  });
});
