import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GladiaTranscriptAccumulator,
  getGladiaModelWarning,
  gladiaTestIntegration,
  isAllowedGladiaWebSocketUrl,
  mapToGladiaLanguageConfig,
  normalizeGladiaModel,
} from "./gladia.utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gladia configuration", () => {
  it("normalizes unsupported persisted models and explains the fallback", () => {
    expect(normalizeGladiaModel(null)).toBe("solaria-1");
    expect(normalizeGladiaModel("legacy-model")).toBe("solaria-1");
    expect(getGladiaModelWarning("legacy-model")).toContain("solaria-1");
    expect(getGladiaModelWarning("solaria-1")).toBeNull();
  });

  it.each([
    ["auto", { languages: [], code_switching: false }],
    ["", { languages: [], code_switching: false }],
    ["en-US", { languages: ["en"], code_switching: false }],
    ["pt-BR", { languages: ["pt"], code_switching: false }],
    ["yue-HK", { languages: ["zh"], code_switching: false }],
  ] as const)("maps %s to Gladia language configuration", (input, expected) => {
    expect(mapToGladiaLanguageConfig(input)).toEqual(expected);
  });

  it("only allows credential-free Gladia production WebSocket endpoints", () => {
    expect(
      isAllowedGladiaWebSocketUrl("wss://api.gladia.io/v2/live?id=one"),
    ).toBe(true);
    expect(
      isAllowedGladiaWebSocketUrl(
        "wss://api.gladia.io:443/v2/live?id=explicit-default-port",
      ),
    ).toBe(true);
    expect(isAllowedGladiaWebSocketUrl("ws://api.gladia.io/v2/live")).toBe(
      false,
    );
    expect(isAllowedGladiaWebSocketUrl("wss://api.gladia.io:444/v2/live")).toBe(
      false,
    );
    expect(
      isAllowedGladiaWebSocketUrl("wss://api.gladia.io.evil.test/live"),
    ).toBe(false);
    expect(
      isAllowedGladiaWebSocketUrl("wss://user:pass@api.gladia.io/live"),
    ).toBe(false);
  });

  it("rejects an empty credential without making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(gladiaTestIntegration({ apiKey: "  " })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates credentials with a non-billable authenticated list request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(gladiaTestIntegration({ apiKey: " key " })).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.gladia.io/v2/pre-recorded?limit=1",
      {
        headers: { "x-gladia-key": "key" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
  });
});

describe("GladiaTranscriptAccumulator", () => {
  it("replaces partial revisions and commits each utterance once", () => {
    const accumulator = new GladiaTranscriptAccumulator();
    expect(accumulator.update("one", "hel", false).committedSegment).toBeNull();
    expect(
      accumulator.update("one", "hello", false).committedSegment,
    ).toBeNull();
    expect(
      accumulator.update("one", "hello world", true).committedSegment,
    ).toBe("hello world");
    expect(
      accumulator.update("one", "duplicate", true).committedSegment,
    ).toBeNull();
    accumulator.update("two", "again", true);

    expect(accumulator.getFinalText()).toBe("hello world again");
  });

  it("prefers Gladia's authoritative post-final transcript", () => {
    const accumulator = new GladiaTranscriptAccumulator();
    accumulator.update("one", "Hello wrld", true);
    accumulator.setAuthoritativeText("Hello world.");
    expect(accumulator.getFinalText()).toBe("Hello world.");
  });

  it("honours an empty authoritative transcript instead of the earlier segments", () => {
    // A provider can retract what it sent: the utterance was noise, or a
    // correction pass decided the recording said nothing. Keeping the earlier
    // segments in that case returns words the provider just withdrew, which is
    // the one thing an authoritative transcript exists to prevent.
    const accumulator = new GladiaTranscriptAccumulator();
    accumulator.update("one", "this was noise", true);
    accumulator.update("two", "neither was this", true);
    expect(accumulator.getFinalText()).toBe("this was noise neither was this");

    accumulator.setAuthoritativeText("   ");

    expect(accumulator.getFinalText()).toBe("");
    // The best-effort path is the last resort, and it must not resurrect what
    // the provider retracted either.
    expect(accumulator.getBestEffortText()).toBe("");
  });

  it("still falls back to the segments when no authoritative text arrived", () => {
    const accumulator = new GladiaTranscriptAccumulator();
    accumulator.update("one", "only segment", true);
    expect(accumulator.getFinalText()).toBe("only segment");
  });

  it("returns partial text only through the explicit best-effort path", () => {
    const accumulator = new GladiaTranscriptAccumulator();
    accumulator.update("one", "unfinished", false);
    expect(accumulator.getFinalText()).toBe("");
    expect(accumulator.getBestEffortText()).toBe("unfinished");
  });
});
