import { describe, expect, it, vi } from "vitest";
import {
  deepgramTestIntegration,
  deepgramTranscribeAudio,
} from "./deepgram.utils";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const makeFetch = (capture: { urls: string[] }) =>
  vi.fn((url: RequestInfo | URL) => {
    capture.urls.push(String(url));
    return Promise.resolve(
      jsonResponse({
        results: {
          channels: [{ alternatives: [{ transcript: "hello world" }] }],
        },
      }),
    );
  });

describe("deepgramTranscribeAudio keyterm prompting", () => {
  it("repeats the keyterm parameter per dictionary term", async () => {
    const capture = { urls: [] as string[] };
    await deepgramTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: ["Soniya", "Ralf"],
      customFetch: makeFetch(capture),
    });

    const url = capture.urls[0];
    expect(url).toBeDefined();
    expect(url).toContain("keyterm=Soniya");
    expect(url).toContain("keyterm=Ralf");
    expect(url.match(/keyterm=/g)?.length).toBe(2);
  });

  it("sends no keyterm parameter when the dictionary is empty", async () => {
    const capture = { urls: [] as string[] };
    await deepgramTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: [],
      customFetch: makeFetch(capture),
    });

    expect(capture.urls[0]).not.toContain("keyterm");
  });

  it("URL-encodes terms and skips blank ones", async () => {
    const capture = { urls: [] as string[] };
    await deepgramTranscribeAudio({
      apiKey: "key",
      blob: new Uint8Array([1, 2]).buffer,
      ext: "wav",
      language: "en",
      keyterms: ["Kanye West", "  "],
      customFetch: makeFetch(capture),
    });

    expect(capture.urls[0]).toContain("keyterm=Kanye+West");
    expect(capture.urls[0].match(/keyterm=/g)?.length).toBe(1);
  });
});

/**
 * A socket that closes on its own with `code`, firing nothing else.
 *
 * Enough to reproduce the failure: the promise is only settled by `onopen` or `onerror`, so a
 * close that carries an unlisted code used to leave it pending forever.
 */
const closingSocket = (code: number) =>
  class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    close(): void {}
    constructor() {
      setTimeout(() => this.onclose?.({ code }), 0);
    }
  };

/** `settled` or `hung`, decided fast, so a regression fails instead of timing out. */
const settleOrHang = async (work: Promise<boolean>): Promise<string> =>
  Promise.race([
    work.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
  ]);

describe("deepgramTestIntegration", () => {
  // 1000 is a NORMAL close, 1006 an abnormal one with no status, 1011 a server error. None of
  // them fires `open` or `error` first, and none was in the list of codes that resolved -- so
  // each of them left the caller waiting on a socket that had already gone, with the 5s safety
  // timeout cleared by the very close that hung it.
  for (const code of [1000, 1006, 1011]) {
    it(`settles when the socket closes with ${code}`, async () => {
      vi.stubGlobal("WebSocket", closingSocket(code));
      try {
        expect(await settleOrHang(deepgramTestIntegration("key"))).toBe(
          "settled",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  // The control: a code that was already handled must keep working, so the cases above are
  // not passing because everything resolves.
  it("settles on a code it already handled", async () => {
    vi.stubGlobal("WebSocket", closingSocket(4001));
    try {
      expect(await settleOrHang(deepgramTestIntegration("key"))).toBe(
        "settled",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // And a successful connection still reports success, which an unconditional `resolve(false)`
  // would break -- `resolve` is idempotent, so the later close must not overwrite it.
  it("still reports a socket that opened", async () => {
    // A stub that fires ONLY `open`. The first version of this extended the closing stub, so
    // its inherited timer fired `onclose` at the same 0ms as `onopen` and won -- the test then
    // reported the fix as broken when it was the stub that was ambiguous.
    class opens {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      close(): void {}
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
    }
    vi.stubGlobal("WebSocket", opens);
    try {
      expect(
        await Promise.race([
          deepgramTestIntegration("key"),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 200),
          ),
        ]),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
