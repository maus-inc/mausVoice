// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApiKeyFormFields } from "./useApiKeyFormFields";
import { useApiKeyFormSave } from "./useApiKeyFormSave";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useApiKeyFormSave", () => {
  let current: ReturnType<typeof useApiKeyFormSave>;
  const Harness = ({
    canSave,
    save,
  }: {
    canSave: boolean;
    save: () => Promise<void>;
  }) => {
    current = useApiKeyFormSave(canSave, save);
    return null;
  };

  it("refuses invalid saves, locks while pending, and releases on success", async () => {
    let release = () => {};
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () =>
      root.render(createElement(Harness, { canSave: false, save })),
    );
    await act(async () => {
      await current.handleSave();
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () =>
      root.render(createElement(Harness, { canSave: true, save })),
    );
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = current.handleSave();
    });
    expect(current.saving).toBe(true);
    await act(async () => {
      await current.handleSave();
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await pending;
    });
    expect(current.saving).toBe(false);
  });

  it("prevents concurrent saves before React renders the pending state", async () => {
    let release = () => {};
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () =>
      root.render(createElement(Harness, { canSave: true, save })),
    );
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = current.handleSave();
      second = current.handleSave();
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await Promise.all([first, second]);
    });
    expect(current.saving).toBe(false);
  });

  it("logs a rejected save and releases the form for another attempt", async () => {
    const error = new Error("save failed");
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const save = vi.fn().mockRejectedValue(error);
    await act(async () =>
      root.render(createElement(Harness, { canSave: true, save })),
    );
    await act(async () => {
      await current.handleSave();
    });
    expect(logger).toHaveBeenCalledWith("Failed to save API key", error);
    expect(current.saving).toBe(false);
    await act(async () => {
      await current.handleSave();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("useApiKeyFormFields", () => {
  it("updates one field without discarding others and supports clearing", async () => {
    let current: ReturnType<typeof useApiKeyFormFields>;
    const initialize = vi.fn(() => ({ baseUrl: "one", apiKey: "key" }));
    const Harness = () => {
      current = useApiKeyFormFields(initialize);
      return null;
    };
    await act(async () => root.render(createElement(Harness)));
    const originalUpdater = current!.handleFieldChange;
    act(() => current!.handleFieldChange("baseUrl", "two"));
    expect(current!.fieldValues).toEqual({ baseUrl: "two", apiKey: "key" });
    expect(current!.handleFieldChange).toBe(originalUpdater);
    expect(initialize).toHaveBeenCalledOnce();
    act(() => current!.setFieldValues({}));
    expect(current!.fieldValues).toEqual({});
  });
});
