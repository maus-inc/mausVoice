import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForHttpServer } from "../webdriver/wait-for-http-server.js";

afterEach(() => {
  vi.useRealTimers();
});

function httpHarness() {
  const requests = [];
  const request = vi.fn((_options, response) => {
    const req = new EventEmitter();
    req.end = vi.fn();
    req.destroy = vi.fn(() =>
      queueMicrotask(() => req.emit("error", new Error("socket closed"))),
    );
    requests.push({ req, response });
    return req;
  });
  return { request, requests };
}

describe("webdriver HTTP readiness ownership", () => {
  it("schedules one retry when a timeout also emits an error", async () => {
    vi.useFakeTimers();
    const http = httpHarness();
    const pending = waitForHttpServer({
      port: 9515,
      timeoutMs: 10_000,
      intervalMs: 500,
      request: http.request,
    });
    http.requests[0].req.emit("timeout");
    await vi.advanceTimersByTimeAsync(500);
    expect(http.requests).toHaveLength(2);
    const response = { statusCode: 200, resume: vi.fn() };
    http.requests[1].response(response);
    await pending;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.requests).toHaveLength(2);
    expect(response.resume).toHaveBeenCalledOnce();
  });

  it("cancels an active wait when its driver is retired", async () => {
    vi.useFakeTimers();
    const http = httpHarness();
    const controller = new AbortController();
    const pending = waitForHttpServer({
      port: 9515,
      timeoutMs: 3_000,
      request: http.request,
      signal: controller.signal,
    });
    const reason = new Error("driver retired");
    const rejection = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    expect(http.requests[0].req.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.requests).toHaveLength(1);
  });

  it("does not issue a request for an already retired driver", async () => {
    const http = httpHarness();
    const controller = new AbortController();
    const reason = new Error("already retired");
    controller.abort(reason);
    await expect(
      waitForHttpServer({
        port: 9515,
        request: http.request,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(http.request).not.toHaveBeenCalled();
  });

  it("settles at the deadline even when a request never emits a timeout", async () => {
    vi.useFakeTimers();
    const http = httpHarness();
    const pending = waitForHttpServer({
      port: 9515,
      timeoutMs: 3_000,
      intervalMs: 500,
      request: http.request,
    });
    const rejection = expect(pending).rejects.toThrow(/9515/);
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(http.requests[0].req.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.requests).toHaveLength(1);
  });

  it("ignores timeout events from a request after readiness was confirmed", async () => {
    vi.useFakeTimers();
    const http = httpHarness();
    const pending = waitForHttpServer({
      port: 9515,
      timeoutMs: 3_000,
      request: http.request,
    });
    http.requests[0].response({ statusCode: 200, resume: vi.fn() });
    await pending;
    http.requests[0].req.emit("timeout");
    expect(http.requests[0].req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(http.requests).toHaveLength(1);
  });

  it("rejects a synchronous request failure and cleans up its deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => {
      throw new Error("invalid port");
    });
    await expect(
      waitForHttpServer({ port: 0, timeoutMs: 3_000, request }),
    ).rejects.toThrow("invalid port");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries server errors and accepts any non-error status below 500", async () => {
    vi.useFakeTimers();
    const http = httpHarness();
    const pending = waitForHttpServer({
      port: 9515,
      timeoutMs: 3_000,
      intervalMs: 500,
      request: http.request,
    });
    http.requests[0].response({ statusCode: 503, resume: vi.fn() });
    await vi.advanceTimersByTimeAsync(500);
    http.requests[1].response({ statusCode: 404, resume: vi.fn() });
    await pending;
    expect(http.requests).toHaveLength(2);
  });
});
