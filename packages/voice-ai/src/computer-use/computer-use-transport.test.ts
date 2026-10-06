import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { ComputerUseActionResult, ComputerUseScreenshot } from "@maus-inc/types";
import type { CustomFetch } from "../types";
import {
  assertScreenshotIsPng,
  assertTurnHasContent,
  buildComputerUseTransport,
  describeResult,
  isTerminalTurn,
  requestComputerUseTurn,
} from "./computer-use-transport";

const LABEL = "Testbed";
const URL = "https://example.invalid/v1/interactions";

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const textResponse = (body: string, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
  }) as unknown as Response;

const turn = (args: {
  transport: ReturnType<typeof buildComputerUseTransport>;
  customFetch?: CustomFetch;
  signal?: AbortSignal;
}) =>
  requestComputerUseTurn({
    transport: args.transport,
    url: URL,
    headers: { "x-test": "1" },
    body: { hello: "world" },
    label: LABEL,
    signal: args.signal,
  });

const makeFetch = (impl: () => Promise<Response>): Mock<() => Promise<Response>> =>
  vi.fn(impl);

const result = (over: Partial<ComputerUseActionResult>): ComputerUseActionResult => ({
  callId: "call-1",
  providerName: "left_click",
  success: true,
  message: "clicked",
  ...over,
});

const screenshot = (mimeType: ComputerUseScreenshot["mimeType"]): ComputerUseScreenshot => ({
  data: "AAAA",
  mimeType,
  width: 1280,
  height: 720,
});

describe("the computer-use transport", () => {
  it("reads a JSON body from a 2xx answer", async () => {
    const customFetch = makeFetch(async () => jsonResponse({ steps: [] }));
    await expect(turn({ transport: buildComputerUseTransport(customFetch) })).resolves.toEqual({
      steps: [],
    });
  });

  it.each([
    ["html", "<html>gateway</html>", /rewrote/],
    ["empty", "", /empty/],
  ])("refuses a %s 2xx body once, without reissuing the request", async (_label, body, expected) => {
    // A gateway that answers 200 with an error page has already been heard
    // from. Reissuing buys the same unreadable answer up to three times, which
    // on a billed endpoint is three charges for one turn, and the raw
    // SyntaxError names a JavaScript engine instead of anything actionable.
    const customFetch = makeFetch(async () => textResponse(body));
    const promise = turn({ transport: buildComputerUseTransport(customFetch) });
    await expect(promise).rejects.toThrow(expected as RegExp);
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("names the provider and the status when the body is unreadable", async () => {
    const customFetch = makeFetch(async () => textResponse("<html>gateway</html>"));
    const promise = turn({ transport: buildComputerUseTransport(customFetch) });
    await expect(promise).rejects.toThrow(new RegExp(`^${LABEL} answered with status 200`));
  });

  it.each([400, 401, 404, 422])("does not reissue a rejected request, status %s", async (status) => {
    const customFetch = makeFetch(async () => textResponse("nope", status));
    const promise = turn({ transport: buildComputerUseTransport(customFetch) });
    await expect(promise).rejects.toThrow();
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("reissues a request the provider did not answer", async () => {
    const customFetch = makeFetch(async () => textResponse("busy", 503));
    const promise = turn({ transport: buildComputerUseTransport(customFetch) });
    await expect(promise).rejects.toThrow();
    expect(customFetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("never reaches the provider when the caller has already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const customFetch = makeFetch(async () => jsonResponse({ steps: [] }));
    const promise = turn({
      transport: buildComputerUseTransport(customFetch),
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow();
    // On a billed endpoint a cancelled turn that still sent a request is a
    // charge for an action the user refused before it began.
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("does not reissue a request the caller aborted part way through", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const customFetch = makeFetch(async () => {
      attempts += 1;
      controller.abort();
      return textResponse("busy", 503);
    });
    const promise = turn({
      transport: buildComputerUseTransport(customFetch),
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("turn shape guards", () => {
  it("names an empty turn rather than ending a run on it", () => {
    // A turn with neither a call nor prose is a provider answer this client
    // cannot read. Ending the run here reports a completed task, so the guard
    // raises instead.
    expect(() => assertTurnHasContent({ actions: [], text: "" })).toThrow(
      /neither an action nor a message/,
    );
  });

  it("accepts a turn that only carries prose", () => {
    expect(() => assertTurnHasContent({ actions: [], text: "All done." })).not.toThrow();
  });

  it("treats a turn with no actions and no prose as unfinished", () => {
    expect(isTerminalTurn({ actions: [], text: "" })).toBe(false);
    expect(isTerminalTurn({ actions: [], text: "All done." })).toBe(true);
  });
});

describe("screenshot format", () => {
  it("requires PNG, and says what arrived instead", () => {
    // Both providers document image/png for their computer-use image results,
    // so a JPEG that reaches here fails on the provider's turn two with an
    // error naming nothing about the format.
    expect(() => assertScreenshotIsPng(screenshot("image/jpeg"))).toThrow(/image\/jpeg/);
  });

  it("accepts a PNG", () => {
    expect(() => assertScreenshotIsPng(screenshot("image/png"))).not.toThrow();
  });
});

describe("result text", () => {
  it("says a skipped action was skipped, not that it failed", () => {
    // The two mean different things to the model: one never happened and the
    // other tried and did not work. Reading them as the same sends the model
    // back to retry an action it declined.
    expect(describeResult(result({ skipped: true, message: "you said no" }))).toBe(
      "Skipped: you said no",
    );
  });

  it("passes an ordinary failure through unchanged", () => {
    expect(describeResult(result({ success: false, message: "the window vanished" }))).toBe(
      "the window vanished",
    );
  });
});