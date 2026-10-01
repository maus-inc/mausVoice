// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkAvailabilityMock,
  getAvailableModelsMock,
  openAICompatibleRepoCalls,
  openAICompatibleRepoFetches,
  savedEndpointFetchArgs,
  privateFetch,
} = vi.hoisted(() => {
  return {
    checkAvailabilityMock: vi.fn(async () => true),
    getAvailableModelsMock: vi.fn(async () => ["model-a", "model-b"]),
    openAICompatibleRepoCalls: [] as string[],
    openAICompatibleRepoFetches: [] as unknown[],
    savedEndpointFetchArgs: [] as string[],
    privateFetch: vi.fn(),
  };
});

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
});

vi.mock("../../repos/ollama.repo", () => ({
  OpenAICompatibleRepo: class {
    constructor(baseUrl: string, _apiKey?: string, customFetch?: typeof fetch) {
      openAICompatibleRepoCalls.push(baseUrl);
      openAICompatibleRepoFetches.push(customFetch);
    }
    checkAvailability = checkAvailabilityMock;
    getAvailableModels = getAvailableModelsMock;
  },
}));

vi.mock("../../utils/secure-fetch.utils", () => ({
  createOpenAICompatibleFetch: vi.fn((apiKeyId: string) => {
    savedEndpointFetchArgs.push(apiKeyId);
    return vi.fn();
  }),
  secureFetch: privateFetch,
}));

import {
  OpenAICompatibleModelPicker,
  PROBE_TIMEOUT_MS,
} from "./OpenAICompatibleModelPicker";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let container: HTMLDivElement;
let root: Root;

const renderPicker = (baseUrl: string | null) => {
  act(() => {
    root.render(
      createElement(OpenAICompatibleModelPicker, {
        apiKeyId: "key-1",
        baseUrl,
        apiKey: null,
        includeV1Path: true,
        selectedModel: null,
        onModelSelect: vi.fn(),
      }),
    );
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  checkAvailabilityMock.mockResolvedValue(true);
  getAvailableModelsMock.mockResolvedValue(["model-a", "model-b"]);
  openAICompatibleRepoCalls.length = 0;
  openAICompatibleRepoFetches.length = 0;
  savedEndpointFetchArgs.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("OpenAICompatibleModelPicker polling", () => {
  it("does not start a second probe while one is still in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst: ((value: boolean) => void) | undefined;
      checkAvailabilityMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      renderPicker("http://127.0.0.1:8080");
      await act(async () => {
        await Promise.resolve();
      });

      // Polling windows pass while the first request is still open: exactly
      // one probe ever runs at a time.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7000);
      });
      expect(checkAvailabilityMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirst?.(true);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the endpoint is available", async () => {
    vi.useFakeTimers();
    try {
      renderPicker("http://127.0.0.1:8080");
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      // First probe resolved available; the models fetch finishes inside.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const afterAvailable = checkAvailabilityMock.mock.calls.length;
      expect(afterAvailable).toBeGreaterThanOrEqual(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(checkAvailabilityMock).toHaveBeenCalledTimes(afterAvailable);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps probing while the endpoint is unavailable", async () => {
    vi.useFakeTimers();
    try {
      checkAvailabilityMock.mockResolvedValue(false);
      renderPicker("http://127.0.0.1:8080");
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      const afterFirst = checkAvailabilityMock.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(7000);
      });
      expect(checkAvailabilityMock.mock.calls.length).toBeGreaterThanOrEqual(
        afterFirst + 2,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a slow response from an earlier URL after the config changes", async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst: ((value: boolean) => void) | undefined;
      checkAvailabilityMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      renderPicker("http://127.0.0.1:8080");
      await act(async () => {
        await Promise.resolve();
      });

      // Config changes while the first request is still in flight.
      checkAvailabilityMock.mockResolvedValue(false);
      renderPicker("http://192.168.1.99:9000");
      await act(async () => {
        await Promise.resolve();
      });

      // The stale first request now resolves available=true; the picker must
      // show the fresh request's result (unavailable), not the stale one.
      await act(async () => {
        resolveFirst?.(true);
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      const text = document.body.textContent ?? "";
      // Fresh state is "unavailable" → manual-input fallback, and none of
      // the stale first request's models leak into the UI.
      expect(text).toContain("doesn't support model listing");
      expect(text).not.toContain("model-a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the /v1 path before probing an ollama-style base URL", async () => {
    renderPicker("http://127.0.0.1:11434");
    await act(async () => {
      await Promise.resolve();
    });

    expect(openAICompatibleRepoCalls[0]).toBe("http://127.0.0.1:11434/v1");
  });
  it("abandons a probe that never settles and schedules the retry", async () => {
    // The retry is only scheduled after the current run settles, so a `/models`
    // request that never answered held the next probe for as long as the network
    // kept it open and the picker sat on its initial loading indicator.
    vi.useFakeTimers();
    try {
      checkAvailabilityMock.mockImplementation(
        () => new Promise<boolean>(() => undefined),
      );
      renderPicker("http://127.0.0.1:8080");
      await act(async () => {
        await Promise.resolve();
      });
      expect(checkAvailabilityMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      });
      // The stuck run is abandoned and the picker falls back to manual input
      // rather than showing "Checking..." forever.
      expect(document.body.textContent).toContain(
        "doesn't support model listing",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(checkAvailabilityMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an abandoned probe that settles after its own deadline", async () => {
    // The deadline has to abandon the run, not just stop waiting on it: a
    // request that answers minutes later still resumes its continuation, and
    // that continuation is the only thing standing between its stale verdict
    // and the state the retry has already written.
    vi.useFakeTimers();
    try {
      let resolveAbandoned: ((value: boolean) => void) | undefined;
      checkAvailabilityMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAbandoned = resolve;
          }),
      );
      // Every later probe reports the endpoint as unavailable.
      checkAvailabilityMock.mockResolvedValue(false);
      renderPicker("http://127.0.0.1:8080");
      await act(async () => {
        await Promise.resolve();
      });
      expect(checkAvailabilityMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(checkAvailabilityMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(document.body.textContent).toContain(
        "doesn't support model listing",
      );

      // The abandoned run finally answers "available", with a model list.
      await act(async () => {
        resolveAbandoned?.(true);
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });

      // The retry's verdict stands: no models are fetched, and the picker keeps
      // the fallback the newer run established.
      expect(getAvailableModelsMock).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "doesn't support model listing",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes a key with no saved base URL through the private fetch", async () => {
    // `createOpenAICompatibleFetch` authorizes against the base URL stored on
    // the API-key row and rejects the call outright when that column is null. A
    // key persisted before the column existed still has none, and
    // `buildOpenAICompatibleUrl` resolves those to the documented local default,
    // so probing it through the saved-endpoint fetch could only ever fail.
    renderPicker(null);
    await act(async () => {
      await Promise.resolve();
    });

    expect(openAICompatibleRepoCalls[0]).toBe("http://127.0.0.1:8080/v1");
    expect(savedEndpointFetchArgs).toHaveLength(0);
    expect(openAICompatibleRepoFetches[0]).toBe(privateFetch);
  });

  it("probes a key with a saved base URL through the saved-endpoint fetch", async () => {
    renderPicker("https://api.example.com");
    await act(async () => {
      await Promise.resolve();
    });

    expect(savedEndpointFetchArgs).toEqual(["key-1"]);
    expect(openAICompatibleRepoFetches[0]).not.toBe(privateFetch);
  });
});
