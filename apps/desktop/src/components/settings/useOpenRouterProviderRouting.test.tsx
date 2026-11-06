// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  config: {
    providerRouting: {
      order: ["a", "b", "unknown"],
      allow_fallbacks: false,
      data_collection: "deny",
    },
  },
  providers: [
    { slug: "a", name: "Alpha" },
    { slug: "b", name: "Beta" },
    { slug: "c", name: "Charlie" },
  ],
  status: "idle",
  load: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../store", () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      settings: {
        openRouterProviders: mocks.providers,
        openRouterProvidersStatus: mocks.status,
      },
    }),
}));
vi.mock("../../actions/openrouter.actions", () => ({
  getOpenRouterConfigForKey: () => mocks.config,
  loadOpenRouterProviders: mocks.load,
  updateOpenRouterProviderRouting: mocks.update,
}));

import { useOpenRouterProviderRouting } from "./useOpenRouterProviderRouting";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let view: ReturnType<typeof useOpenRouterProviderRouting>;
const Harness = ({ disabled = false }: { disabled?: boolean }) => {
  view = useOpenRouterProviderRouting("key", disabled);
  return null;
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.status = "idle";
  mocks.config = {
    providerRouting: {
      order: ["a", "b", "unknown"],
      allow_fallbacks: false,
      data_collection: "deny",
    },
  };
  mocks.load.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("OpenRouter routing state", () => {
  it("summarizes names, excludes selected providers, and loads when expanded", () => {
    expect(view.summary).toBe("Alpha, Beta +1");
    expect(view.getProviderName("unknown")).toBe("unknown");
    expect(view.availableToAdd).toEqual([{ slug: "c", name: "Charlie" }]);
    expect(view.allowFallbacks).toBe(false);
    expect(view.dataCollection).toBe("deny");
    expect(mocks.load).not.toHaveBeenCalled();
    act(() => view.handleToggleExpand());
    expect(view.expanded).toBe(true);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("does not expand or load when disabled", async () => {
    await act(async () =>
      root.render(createElement(Harness, { disabled: true })),
    );
    act(() => view.handleToggleExpand());
    expect(view.expanded).toBe(false);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("changes provider order and preserves the rest of the routing", async () => {
    await act(async () => {
      view.handleAddProvider("c");
    });
    expect(mocks.update).toHaveBeenLastCalledWith("key", {
      ...mocks.config.providerRouting,
      order: ["a", "b", "unknown", "c"],
    });
    await act(async () => {
      view.handleRemoveProvider(1);
    });
    expect(mocks.update).toHaveBeenLastCalledWith("key", {
      ...mocks.config.providerRouting,
      order: ["a", "unknown"],
    });
    await act(async () => {
      view.handleMoveProvider(1, "up");
    });
    expect(mocks.update).toHaveBeenLastCalledWith("key", {
      ...mocks.config.providerRouting,
      order: ["b", "a", "unknown"],
    });
    mocks.update.mockClear();
    act(() => {
      view.handleMoveProvider(0, "up");
      view.handleMoveProvider(2, "down");
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("persists fallback and data collection choices", async () => {
    await act(async () => {
      view.handleFallbacksChange({
        target: { checked: true },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    expect(mocks.update).toHaveBeenLastCalledWith("key", {
      ...mocks.config.providerRouting,
      allow_fallbacks: true,
    });
    await act(async () => {
      view.handleDataCollectionChange({
        target: { value: "allow" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    expect(mocks.update).toHaveBeenLastCalledWith("key", {
      ...mocks.config.providerRouting,
      data_collection: "allow",
    });
  });

  it("rejects overlapping saves and recovers after a reported failure", async () => {
    const error = new Error("save failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let reject: (error: Error) => void = () => undefined;
    mocks.update.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    act(() => {
      view.handleAddProvider("c");
      view.handleRemoveProvider(0);
    });
    expect(view.saving).toBe(true);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(error);
      await Promise.resolve();
    });
    expect(view.saving).toBe(false);
    expect(log).toHaveBeenCalledWith(
      "Failed to save OpenRouter provider routing",
      error,
    );
    await act(async () => {
      view.handleRemoveProvider(0);
    });
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
});
