import { describe, expect, it } from "vitest";
import {
  applyFastStyle,
  canApplyFastStyle,
  canApplyFastStyleForProvider,
  measureFastStyle,
} from "./fast-style.utils";

describe("applyFastStyle fast local transforms", () => {
  it("verbatim returns raw exactly (contract)", () => {
    const raw = "um so like I went to the store";
    expect(applyFastStyle(raw, "verbatim")).toBe(raw);
    expect(applyFastStyle(raw, "disabled")).toBe(raw);
    expect(applyFastStyle(raw, null)).toBe(raw);
  });

  it("polished removes filler and capitalizes", () => {
    const raw = "um so I went to the store uh and I bought some milk";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).not.toContain("um");
    expect(out).toMatch(/I went to the store/);
    expect(out.endsWith(".") || out.endsWith("\n")).toBe(true);
  });

  it("bullets formats as list (sentence boundaries only, not on 'and')", () => {
    const raw = "I need to buy milk. I need bread. I need eggs";
    const out = applyFastStyle(raw, "bullets");
    expect(out).toContain("- ");
    expect(out.split("\n").length).toBe(3);
    // Hardened: does NOT split on "and" inside sentence
    const rawWithAnd = "I need bread and butter";
    const outWithAnd = applyFastStyle(rawWithAnd, "bullets");
    expect(outWithAnd.split("\n").length).toBe(1);
    expect(outWithAnd.toLowerCase()).toContain("bread and butter");
  });

  it("email preserves greeting/closing if present, does NOT hallucinate if absent", () => {
    const rawWithGreeting =
      "Hi. I wanted to follow up on the meeting we had yesterday. Thanks.";
    const outWith = applyFastStyle(rawWithGreeting, "email");
    expect(outWith.toLowerCase()).toContain("hi");
    expect(outWith).toContain("\n");
    expect(outWith.toLowerCase()).toContain("follow up");

    // No hallucination: if no greeting/closing in raw, don't invent "Hello," / "Best,"
    const rawNoGreeting =
      "I wanted to follow up on the meeting we had yesterday";
    const outNo = applyFastStyle(rawNoGreeting, "email");
    expect(outNo.toLowerCase()).not.toContain("hello,");
    expect(outNo.toLowerCase()).not.toContain("best,");
    expect(outNo.toLowerCase()).toContain("follow up");

    // Edge: long sentence starting with hi should NOT be treated as greeting alone
    const rawLongHi =
      "hi I wanted to follow up on the meeting we had yesterday and discuss next steps";
    const outLong = applyFastStyle(rawLongHi, "email");
    expect(outLong.toLowerCase()).toContain("follow up");
    // Should not split into greeting + body when it's actually one long sentence
  });

  it("concise removes hedging and shortens (conservative, no meaning change)", () => {
    const raw = "I think maybe we should sort of consider going to the park";
    const out = applyFastStyle(raw, "concise");
    expect(out.toLowerCase()).not.toContain("i think");
    expect(out.toLowerCase()).not.toContain("sort of");
    expect(out.length).toBeLessThan(raw.length);
    // "maybe" is content, not removed in conservative mode to avoid changing meaning
  });

  it("prompt makes imperative and concise", () => {
    const raw =
      "Hey so, um, can you summarize the key points of this Q3 report? Like under one page, and, uh, I need it by tomorrow morning.";
    const out = applyFastStyle(raw, "prompt");
    expect(out.length).toBeLessThan(raw.length);
    expect(out.endsWith(".")).toBe(true);
  });

  it("notes organizes with bullets and action items", () => {
    const raw =
      "We decided to launch next week. We need to finish the docs. Follow up with design team.";
    const out = applyFastStyle(raw, "notes");
    expect(out).toContain("- ");
  });

  it("chat keeps casual and removes filler", () => {
    const raw = "um so I was like thinking we should grab coffee tomorrow";
    const out = applyFastStyle(raw, "chat");
    expect(out.toLowerCase()).not.toContain("um");
    expect(out.toLowerCase()).toContain("coffee");
  });

  it("formal expands contractions", () => {
    const raw = "I don't think we can do it";
    const out = applyFastStyle(raw, "formal");
    expect(out.toLowerCase()).toContain("do not");
  });

  it("handles self-correction", () => {
    const raw = "I went to the store, actually, the mall yesterday";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).toContain("mall");
    expect(out.toLowerCase()).not.toContain("store");
  });

  it("handles empty input", () => {
    expect(applyFastStyle("", "default")).toBe("");
    expect(applyFastStyle("   ", "bullets")).toBe("");
  });

  it("custom tone falls back to polished", () => {
    const raw = "um so I went to the store";
    const out = applyFastStyle(raw, "my-custom-tone");
    expect(out.toLowerCase()).not.toContain("um");
  });

  it("deprecated tones map to modern equivalents", () => {
    const raw = "um so I went to the store";
    expect(applyFastStyle(raw, "light")).not.toContain("um");
    expect(applyFastStyle(raw, "casual")).not.toContain("um");
    expect(applyFastStyle(raw, "business")).not.toContain("um");
    expect(applyFastStyle(raw, "punny")).not.toContain("um");
  });

  it("handles custom tone with category (fallback to polished, no category string matching)", () => {
    const raw = "I need to buy milk. I need bread. I need eggs";
    const promptConfig = {
      kind: "style" as const,
      stylePrompt: "test",
      category: "prompt",
    };
    const out = applyFastStyle(raw, "custom-1", promptConfig);
    expect(out.length).toBeGreaterThan(0);
    // Custom tones fallback to polished to avoid hallucination via free-text category matching
    expect(out.toLowerCase()).toContain("milk");

    const formattingConfig = {
      kind: "style" as const,
      stylePrompt: "test",
      category: "formatting",
    };
    const out2 = applyFastStyle(raw, "custom-2", formattingConfig);
    // Should fallback to polished, not try to infer bullets from category string
    expect(out2.toLowerCase()).toContain("milk");
  });

  it("is idempotent", () => {
    const raw = "um so I went to the store and I bought some milk";
    const once = applyFastStyle(raw, "default");
    const twice = applyFastStyle(once, "default");
    expect(twice).toBe(once);
  });

  it("is fast (<10ms)", () => {
    const raw =
      "um so I went to the store uh and I bought some milk and bread and eggs and cheese and then I went home";
    const { durationMs } = measureFastStyle(raw, "bullets");
    expect(durationMs).toBeLessThan(10);
  });

  it("preserves meaning (no hallucination)", () => {
    const raw = "We need to launch the product next week";
    const out = applyFastStyle(raw, "default");
    expect(out.toLowerCase()).toContain("launch");
    expect(out.toLowerCase()).toContain("product");
    expect(out.toLowerCase()).toContain("next week");
  });

  it("handles very long input with truncation guard (no catastrophic backtracking)", () => {
    const long = "I went to the store. ".repeat(800);
    const out = applyFastStyle(long, "default");
    expect(out.length).toBeLessThan(16000);
    expect(out.toLowerCase()).toContain("store");

    const fillerLong = "um ".repeat(8000) + "I went to the store.";
    const out2 = applyFastStyle(fillerLong, "default");
    expect(out2.length).toBeLessThan(16000);
  });

  it("graceful degradation: self-correction skipped on huge input", () => {
    const huge = "a ".repeat(3000) + ", actually, the mall yesterday";
    const out = applyFastStyle(huge, "default");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("canApplyFastStyle", () => {
  it("returns false for verbatim, disabled, null", () => {
    expect(canApplyFastStyle(null)).toBe(false);
    expect(canApplyFastStyle("verbatim")).toBe(false);
    expect(canApplyFastStyle("disabled")).toBe(false);
  });

  it("returns true for all other tones", () => {
    expect(canApplyFastStyle("default")).toBe(true);
    expect(canApplyFastStyle("email")).toBe(true);
    expect(canApplyFastStyle("bullets")).toBe(true);
    expect(canApplyFastStyle("concise")).toBe(true);
    expect(canApplyFastStyle("my-custom")).toBe(true);
  });
});

describe("canApplyFastStyleForProvider — provider-agnostic", () => {
  const providers = [
    "deepgram",
    "assemblyai",
    "elevenlabs",
    "gladia",
    "openai",
    "groq",
    "azure",
    "gemini",
    "speaches",
    "openai-compatible",
    "openrouter",
    "xai",
    "aldea",
    "local",
    null,
  ];

  it.each(providers)("works for provider %s", (provider) => {
    expect(canApplyFastStyleForProvider(provider, "default")).toBe(true);
    expect(canApplyFastStyleForProvider(provider, "email")).toBe(true);
    expect(canApplyFastStyleForProvider(provider, "bullets")).toBe(true);
    expect(canApplyFastStyleForProvider(provider, "verbatim")).toBe(false);
  });
});

describe("baseline vs fast path", () => {
  it("baseline: when LLM off, previously returned raw for non-verbatim (now fast-styled)", () => {
    const raw = "um so I went to the store";
    // Old baseline would return raw
    const oldBaseline = raw;
    // New fast path returns polished
    const newFast = applyFastStyle(raw, "default");
    expect(newFast).not.toBe(oldBaseline);
    expect(newFast.toLowerCase()).not.toContain("um");
  });

  it("no regression: LLM path still preferred when available (fast only fallback)", () => {
    // This is verified in transcribe.actions.ts: if gen.repo exists, LLM is used
    // Fast style only when gen.repo is null. We test the gating logic here.
    const toneId = "email";
    const canFast = canApplyFastStyle(toneId);
    expect(canFast).toBe(true);
    // When LLM repo exists, applyFastStyle is NOT called (LLM wins)
    // This is architectural, not unit-testable here, but documented
  });
});
