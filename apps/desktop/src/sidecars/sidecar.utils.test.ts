import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { secureFetchMock } = vi.hoisted(() => ({
  secureFetchMock:
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("../utils/secure-fetch.utils", () => ({
  secureFetch: secureFetchMock,
}));
import { fetchWithTimeout } from "./sidecar.utils";

beforeEach(() => {
  vi.useFakeTimers();
  secureFetchMock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("sidecar request timeout", () => {
  it("aborts a timed-out request even if the transport ignores cancellation", async () => {
    secureFetchMock.mockImplementation(() => new Promise(() => undefined));
    const pending = fetchWithTimeout(
      "http://localhost:1234/health",
      undefined,
      100,
    );
    const result = expect(pending).rejects.toThrow("Request timed out");
    const signal = secureFetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it("does not expose private transport failure details", async () => {
    secureFetchMock.mockRejectedValue(
      new TypeError("transport echoed private-audio-fragment"),
    );
    const error = await fetchWithTimeout(
      "http://localhost:1234/private",
      { method: "POST", body: "private-audio" },
      100,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Sidecar transport failed");
    expect(String(error)).not.toContain("private-audio");
  });

  it("also sanitizes a synchronous transport exception", async () => {
    secureFetchMock.mockImplementation(() => {
      throw new Error("private-audio-fragment");
    });
    await expect(
      fetchWithTimeout("http://localhost:1234/private", undefined, 100),
    ).rejects.toThrow("Sidecar transport failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps independent abort errors recognizable without exposing their details", async () => {
    secureFetchMock.mockRejectedValue(
      new DOMException("private-audio-fragment", "AbortError"),
    );
    const error = await fetchWithTimeout(
      "http://localhost:1234/private",
      undefined,
      100,
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toContain("private-audio");
  });

  it("does not expose request URLs in timeout errors", async () => {
    secureFetchMock.mockImplementation(() => new Promise(() => undefined));
    const pending = fetchWithTimeout(
      "http://user:password@localhost:1234/health?token=private",
      undefined,
      100,
    );
    const result = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await result;
    if (!(error instanceof Error)) throw new Error("Expected a timeout error");
    expect(error.message).toBe("Request timed out");
    expect(error.message).not.toMatch(/password|private|localhost/);
  });

  it("forwards the caller's abort and removes its listener after settlement", async () => {
    secureFetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = fetchWithTimeout(
      "http://localhost:1234/health",
      { signal: controller.signal },
      100,
    );
    const reason = new Error("caller cancelled");
    const result = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await result;
    expect(secureFetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles promptly on caller abort even if the transport ignores cancellation", async () => {
    secureFetchMock.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = fetchWithTimeout(
      "http://localhost:1234/health",
      { signal: controller.signal },
      100,
    );
    const reason = new Error("caller stopped waiting");
    const result = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    secureFetchMock.mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return new Response("unexpected");
    });
    await expect(
      fetchWithTimeout(
        "http://localhost:1234/health",
        { signal: controller.signal },
        100,
      ),
    ).rejects.toBe(reason);
    expect(secureFetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort the caller's own signal when its deadline expires", async () => {
    const controller = new AbortController();
    secureFetchMock.mockImplementation(() => new Promise(() => undefined));
    const pending = fetchWithTimeout(
      "http://localhost:1234/health",
      { signal: controller.signal },
      100,
    );
    const result = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(controller.signal.aborted).toBe(false);
    expect(secureFetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each(["timeout", "caller cancellation"])(
    "discards a response arriving after %s",
    async (termination) => {
      let resolveResponse!: (response: Response) => void;
      secureFetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const controller = new AbortController();
      const pending = fetchWithTimeout(
        "http://localhost:1234/health",
        { signal: controller.signal },
        100,
      );
      const reason = new Error("caller cancelled");
      const result = pending.catch((error: unknown) => error);
      if (termination === "timeout") await vi.advanceTimersByTimeAsync(100);
      else controller.abort(reason);
      expect(await result).toBeInstanceOf(Error);
      const response = new Response("late private response");
      const cancel = vi
        .spyOn(response.body!, "cancel")
        .mockReturnValue(new Promise(() => {}));
      resolveResponse(response);
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("never follows sidecar redirects, even if request options ask to follow", async () => {
    secureFetchMock.mockResolvedValue(new Response("ok"));
    await fetchWithTimeout(
      "http://127.0.0.1:1234/v1/transcriptions/sessions/s1/chunks",
      { method: "POST", body: new ArrayBuffer(8), redirect: "follow" },
      100,
    );
    expect(secureFetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/transcriptions/sessions/s1/chunks",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("cleans up its timeout and caller listener when the request succeeds", async () => {
    const response = new Response("ok");
    secureFetchMock.mockResolvedValue(response);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    expect(
      await fetchWithTimeout(
        "http://localhost:1234/health",
        { method: "POST", signal: controller.signal },
        100,
      ),
    ).toBe(response);
    expect(secureFetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
