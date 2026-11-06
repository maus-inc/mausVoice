// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  available: vi.fn<(signal?: AbortSignal) => Promise<boolean>>(),
  models: vi.fn<(signal?: AbortSignal) => Promise<string[]>>(),
  endpoints: [] as string[],
}));
vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});
vi.mock("../../repos/ollama.repo", () => ({
  OllamaRepo: class {
    constructor(url: string) {
      mocks.endpoints.push(url);
    }
    checkAvailability = mocks.available;
    getAvailableModels = mocks.models;
  },
}));

import { OllamaModelPicker } from "./OllamaModelPicker";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
const renderPicker = (baseUrl: string) =>
  act(() =>
    root.render(
      <OllamaModelPicker
        baseUrl={baseUrl}
        apiKey="arbitrary-secret"
        selectedModel={null}
        onModelSelect={() => {}}
      />,
    ),
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.endpoints.length = 0;
  mocks.available.mockResolvedValue(true);
  mocks.models.mockResolvedValue(["model-a"]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("Ollama model picker", () => {
  it("retries unavailable endpoints and stops after recovery", async () => {
    vi.useFakeTimers();
    mocks.available.mockResolvedValueOnce(false).mockResolvedValue(true);
    renderPicker("http://127.0.0.1:11434");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.textContent).toContain("Unable to connect to Ollama");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.available).toHaveBeenCalledTimes(2);
    expect(mocks.models).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.available).toHaveBeenCalledTimes(2);
  });

  it("aborts the previous endpoint and ignores its late response", async () => {
    let release: (available: boolean) => void = () => {};
    mocks.available
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValue(false);
    renderPicker("http://127.0.0.1:11434");
    const firstSignal = mocks.available.mock.calls[0][0];
    renderPicker("http://127.0.0.1:11435");
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      release(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.models).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unable to connect to Ollama");
  });

  it("does not put opaque provider errors or credentials in the console", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      mocks.models.mockRejectedValueOnce(
        new Error("arbitrary-secret provider details"),
      );
      renderPicker("http://127.0.0.1:11434");
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to fetch Ollama models",
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
