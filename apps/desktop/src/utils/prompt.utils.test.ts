import { describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET,
  AZURE_PHRASE_LIST_BUDGET,
  buildLocalizedTranscriptionPrompt,
  buildPostProcessingPrompt,
  buildProviderVocabulary,
  buildSystemPostProcessingTonePrompt,
  capVocabularyTerms,
  collectVocabularyTerms,
  DEEPGRAM_KEYTERM_BUDGET,
  estimateTokenCount,
  ELEVENLABS_BATCH_KEYTERMS_BUDGET,
  ELEVENLABS_REALTIME_KEYTERMS_BUDGET,
  GLOSSARY_EXACT_SPELLING_INSTRUCTION,
  GLOSSARY_PROMPT_BUDGET,
  isGlossaryPromptTruncated,
  PostProcessingPromptInput,
} from "./prompt.utils";
import { HUMANIZE_SKILL_TEXT } from "./humanize.utils";
import { StyleToneConfig, TemplateToneConfig } from "./tone.utils";

const makeInput = (
  tone: StyleToneConfig | TemplateToneConfig,
  overrides: Partial<Omit<PostProcessingPromptInput, "tone">> = {},
): PostProcessingPromptInput => ({
  transcript: "Hello world",
  userName: "Alice",
  dictationLanguage: "en",
  tone,
  glossary: { sources: [], replacements: [] },
  ...overrides,
});

describe("buildSystemPostProcessingTonePrompt", () => {
  it("returns default system prompt for style config", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).toContain("Be formal");
    expect(result).toContain("English");
  });

  it("includes the shared humanize skill in every system prompt", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be concise" }),
    );
    expect(result).toContain(HUMANIZE_SKILL_TEXT);
  });

  it("appends structured style guidance when it is present", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({
        kind: "style",
        stylePrompt: "Condense the transcript",
        category: "prompt",
        outputLength: "1-3 sentences",
        exampleInputOutput: "Input: rambling. Output: concise.",
      }),
    );
    expect(result).toContain("Category: prompt");
    expect(result).toContain("Output length: 1-3 sentences");
    expect(result).toContain("Example input/output");
  });

  it("returns custom system prompt for template config", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({
        kind: "template",
        promptTemplate: "Process: <transcript/>",
        systemPromptTemplate: "You are a custom assistant for the enterprise.",
      }),
    );
    expect(result).toContain("You are a custom assistant for the enterprise.");
    expect(result).toContain(GLOSSARY_EXACT_SPELLING_INSTRUCTION);
    expect(result).toContain(HUMANIZE_SKILL_TEXT);
  });

  it("substitutes variables in template system prompt", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        {
          kind: "template",
          promptTemplate: "ignored",
          systemPromptTemplate:
            "You assist <username/> with transcripts in <language/>.",
        },
        { userName: "Bob", dictationLanguage: "fr" },
      ),
    );
    expect(result).toContain("You assist Bob with transcripts in Français.");
    expect(result).toContain(GLOSSARY_EXACT_SPELLING_INSTRUCTION);
    expect(result).toContain(HUMANIZE_SKILL_TEXT);
  });

  it("falls back to default when template config has no systemPromptTemplate", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({
        kind: "template",
        promptTemplate: "Process: <transcript/>",
      }),
    );
    expect(result).toContain("Clean up the provided transcript");
    expect(result).toContain("English");
  });

  it("includes the glossary exact-spelling instruction in the style system prompt", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).toContain(GLOSSARY_EXACT_SPELLING_INSTRUCTION);
  });

  it("includes the glossary terms next to the exact-spelling instruction", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        { kind: "style", stylePrompt: "Be formal" },
        {
          glossary: {
            sources: ["Soniya", "Ralf"],
            replacements: [{ source: "k8s", destination: "Kubernetes" }],
          },
        },
      ),
    );
    expect(result).toContain("Terms: Soniya, Ralf");
    expect(result).toContain("Spellings: k8s → Kubernetes");
    // The instruction must come after the glossary it refers to.
    expect(result.indexOf("Terms: Soniya, Ralf")).toBeLessThan(
      result.indexOf(GLOSSARY_EXACT_SPELLING_INSTRUCTION),
    );
  });

  it("omits the glossary section when the dictionary is empty", () => {
    const result = buildSystemPostProcessingTonePrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).not.toContain("User glossary");
    expect(result).toContain(GLOSSARY_EXACT_SPELLING_INSTRUCTION);
  });

  it("shares one character budget between terms and replacement rules", () => {
    // 40 terms of 27 characters consume 1158 of the 2000-character budget,
    // so the rules must fit inside what is left, not a fresh 2000.
    const sources = Array.from(
      { length: 40 },
      (_, i) => `source-term-${i}-padding-pad`,
    );
    const rules = Array.from({ length: 120 }, (_, i) => ({
      source: `s${i}`,
      destination: `destination-${i}`,
    }));
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        { kind: "style", stylePrompt: "Be formal" },
        { glossary: { sources, replacements: rules } },
      ),
    );
    const termsLine = result.match(/Terms: (.*)/)?.[1] ?? "";
    const spellingsLine = result.match(/Spellings: (.*)/)?.[1] ?? "";
    expect(termsLine.length).toBeGreaterThan(1000);
    expect(termsLine.length + spellingsLine.length).toBeLessThanOrEqual(2_000);
    // 120 rules cannot fit in the leftover budget, so entries were dropped.
    expect(spellingsLine).not.toContain("s119");
  });

  it("caps replacement rules under the glossary character budget", () => {
    const longRules = Array.from({ length: 120 }, (_, i) => ({
      source: `src${i}`,
      destination: `destination-${i}-with-a-long-suffix`,
    }));
    const result = buildSystemPostProcessingTonePrompt(
      makeInput(
        { kind: "style", stylePrompt: "Be formal" },
        {
          glossary: { sources: [], replacements: longRules },
        },
      ),
    );
    const spellings = result.match(/Spellings: (.*)/)?.[1] ?? "";
    expect(spellings.length).toBeLessThanOrEqual(
      GLOSSARY_PROMPT_BUDGET.maxCharacters,
    );
    // With no source terms the rules get the whole shared budget, so the
    // full 120-rule list (over 3,900 characters) must be cut short.
    expect(spellings).not.toContain("src119");
    expect(spellings).toContain("src0");
  });
});

describe("glossary template variable", () => {
  it("inserts template values verbatim when they contain dollar patterns", () => {
    const result = buildPostProcessingPrompt(
      makeInput(
        {
          kind: "template",
          promptTemplate: "Glossary: <glossary/>. <transcript/>",
        },
        {
          glossary: {
            sources: ["cost$&price", "fee$`quote"],
            replacements: [],
          },
        },
      ),
    );
    // $& and $` must land in the prompt exactly as written, not be
    // interpreted as replace patterns.
    expect(result).toContain("cost$&price");
    expect(result).toContain("fee$`quote");
  });

  it("substitutes <glossary/> in template prompts", () => {
    const result = buildPostProcessingPrompt(
      makeInput(
        {
          kind: "template",
          promptTemplate: "Glossary: <glossary/>. <transcript/>",
        },
        {
          glossary: {
            sources: ["Soniya"],
            replacements: [{ source: "k8s", destination: "Kubernetes" }],
          },
        },
      ),
    );
    expect(result).toContain("Glossary: Soniya; k8s → Kubernetes.");
  });
});

describe("collectVocabularyTerms", () => {
  it("merges glossary sources and replacement destinations without duplicates", () => {
    expect(
      collectVocabularyTerms({
        sources: ["Soniya", "k8s"],
        replacements: [{ source: "k8s", destination: "Kubernetes" }],
      }),
    ).toEqual(["Soniya", "k8s", "Kubernetes"]);
  });

  it("prefers the replacement destination when it collides with a source", () => {
    expect(
      collectVocabularyTerms({
        sources: ["soniya"],
        replacements: [{ source: "soniya", destination: "Soniya" }],
      }),
    ).toEqual(["Soniya"]);
  });
});

describe("capVocabularyTerms", () => {
  it("caps the entry count and reports truncation", () => {
    const terms = Array.from({ length: 10 }, (_, i) => `term${i}`);
    const { terms: capped, truncated } = capVocabularyTerms(terms, {
      maxEntries: 3,
      maxCharacters: 100,
    });
    expect(capped).toEqual(["term0", "term1", "term2"]);
    expect(truncated).toBe(true);
  });

  it("caps the character budget and reports truncation", () => {
    const { terms: capped, truncated } = capVocabularyTerms(
      ["aaaaaaaaaa", "bbbbbbbbbb", "cc"],
      { maxEntries: 10, maxCharacters: 15 },
    );
    expect(capped).toEqual(["aaaaaaaaaa"]);
    expect(truncated).toBe(true);
  });

  it("skips terms beyond the per-term length limit", () => {
    const { terms: capped, truncated } = capVocabularyTerms(
      ["ok", "way-too-long-term"],
      { maxEntries: 10, maxCharacters: 100, maxTermLength: 10 },
    );
    expect(capped).toEqual(["ok"]);
    expect(truncated).toBe(true);
  });

  it("reports no truncation when everything fits", () => {
    const { terms: capped, truncated } = capVocabularyTerms(["a", "b"], {
      maxEntries: 10,
      maxCharacters: 100,
    });
    expect(capped).toEqual(["a", "b"]);
    expect(truncated).toBe(false);
  });
});

describe("isGlossaryPromptTruncated", () => {
  it("reports no truncation when the glossary fits the prompt budget", () => {
    expect(
      isGlossaryPromptTruncated({
        sources: ["Soniya"],
        replacements: [{ source: "k8s", destination: "Kubernetes" }],
      }),
    ).toBe(false);
  });

  it("reports truncation when sources exceed the entry budget", () => {
    const manySources = Array.from({ length: 120 }, (_, i) => `term${i}`);
    expect(
      isGlossaryPromptTruncated({
        sources: manySources,
        replacements: [],
      }),
    ).toBe(true);
  });

  it("reports truncation when replacement rules exceed the entry budget", () => {
    const manyRules = Array.from({ length: 120 }, (_, i) => ({
      source: `src${i}`,
      destination: `dest${i}`,
    }));
    expect(
      isGlossaryPromptTruncated({ sources: [], replacements: manyRules }),
    ).toBe(true);
  });

  it("does not reserve the inter-group delimiter when no rules survive capping", () => {
    // Sources consume 1996 of the 2000-character budget. The replacement
    // rule "x → y" (5 chars) cannot fit in the remaining 4 characters, so
    // it is filtered out. The two-pass cap does not reserve the "; "
    // delimiter before it knows whether both groups will survive, so the
    // rules get the full remaining budget (4 instead of 2). The rule is
    // still too long, but the budget accounting is correct.
    expect(
      isGlossaryPromptTruncated({
        sources: ["a".repeat(1996)],
        replacements: [{ source: "x", destination: "y" }],
      }),
    ).toBe(true);
  });
});

describe("capVocabularyTerms separator accounting", () => {
  it("counts the join separators toward the character budget", () => {
    // "aaaa, bbbb" joined is 10 characters, which busts a 9-character
    // budget, so only the first term fits.
    const { terms: capped, truncated } = capVocabularyTerms(["aaaa", "bbbb"], {
      maxEntries: 10,
      maxCharacters: 9,
    });
    expect(capped).toEqual(["aaaa"]);
    expect(truncated).toBe(true);
    expect(capped.join(", ").length).toBeLessThanOrEqual(9);
  });
});

describe("capVocabularyTerms per-term word limit", () => {
  it("skips phrases beyond the word limit", () => {
    const { terms: capped, truncated } = capVocabularyTerms(
      ["ok term", "one two three four five six"],
      { maxEntries: 10, maxCharacters: 100, maxWordsPerTerm: 5 },
    );
    expect(capped).toEqual(["ok term"]);
    expect(truncated).toBe(true);
  });
});

describe("buildProviderVocabulary", () => {
  it("returns terms and no warning when everything fits", () => {
    const { terms, warning } = buildProviderVocabulary(
      { sources: ["Soniya"], replacements: [] },
      { maxEntries: 10, maxCharacters: 100 },
      "Test",
    );
    expect(terms).toEqual(["Soniya"]);
    expect(warning).toBeNull();
  });

  it("reports a warning naming the provider when entries are dropped", () => {
    const { terms, warning } = buildProviderVocabulary(
      { sources: ["a", "b", "c"], replacements: [] },
      { maxEntries: 2, maxCharacters: 100 },
      "Test",
    );
    expect(terms).toEqual(["a", "b"]);
    expect(warning).toBe(
      "Some dictionary entries were omitted from Test vocabulary hints because the safe payload budget was reached.",
    );
  });
});

describe("estimateTokenCount", () => {
  it("counts Latin text at roughly four characters per token", () => {
    expect(estimateTokenCount("hello world")).toBeCloseTo(2.75, 10);
    expect(estimateTokenCount("")).toBe(0);
  });

  it("counts CJK characters at a token each", () => {
    expect(estimateTokenCount("你好世界")).toBe(4);
  });

  it("counts emoji at a token each and combining marks at zero", () => {
    expect(estimateTokenCount("🎉🎉")).toBe(2);
    expect(estimateTokenCount("e\u0301")).toBe(0.25);
  });
});

describe("capVocabularyTerms token budget", () => {
  const budget = {
    maxEntries: 100,
    maxCharacters: 10_000,
    maxEstimatedTokens: 450,
  };

  it("caps CJK-heavy lists by tokens before the character budget binds", () => {
    const terms = Array.from({ length: 100 }, (_, i) => `北京市朝阳区${i}`);
    const {
      terms: capped,
      truncated,
      estimatedTokens,
    } = capVocabularyTerms(terms, budget);
    expect(truncated).toBe(true);
    expect(capped.length).toBeLessThan(terms.length);
    expect(estimatedTokens).toBeLessThanOrEqual(450);
  });

  it("caps emoji-heavy lists by tokens", () => {
    const terms = Array.from({ length: 100 }, () => "🎉🎊🎈🎁🎉🎊");
    const {
      terms: capped,
      truncated,
      estimatedTokens,
    } = capVocabularyTerms(terms, budget);
    expect(truncated).toBe(true);
    expect(capped.length).toBeLessThan(terms.length);
    expect(estimatedTokens).toBeLessThanOrEqual(450);
  });

  it("keeps Latin lists under the token ceiling through the shared path", () => {
    const terms = Array.from({ length: 50 }, (_, i) => `Contact${i} Anderson`);
    const { terms: capped, warning } = buildProviderVocabulary(
      { sources: terms, replacements: [] },
      DEEPGRAM_KEYTERM_BUDGET,
      "Deepgram",
    );
    const total = estimateTokenCount(capped.join(", "));
    expect(total).toBeLessThanOrEqual(450);
    expect(warning).toBeNull();
  });

  it("flags truncation with the provider name when tokens overflow", () => {
    const terms = Array.from({ length: 100 }, (_, i) => `北京市朝阳区${i}海淀区`);
    const { terms: capped, warning } = buildProviderVocabulary(
      { sources: terms, replacements: [] },
      DEEPGRAM_KEYTERM_BUDGET,
      "Deepgram",
    );
    expect(capped.length).toBeLessThan(terms.length);
    expect(estimateTokenCount(capped.join(", "))).toBeLessThanOrEqual(450);
    expect(warning).toContain("Deepgram");
  });
});

describe("provider budgets match documented API limits", () => {
  it("Deepgram stays under the documented 500-token keyterm total", () => {
    expect(DEEPGRAM_KEYTERM_BUDGET.maxEntries).toBe(100);
    expect(DEEPGRAM_KEYTERM_BUDGET.maxCharacters).toBeLessThanOrEqual(1500);
    expect(DEEPGRAM_KEYTERM_BUDGET.maxEstimatedTokens).toBeLessThanOrEqual(500);
  });

  it("AssemblyAI streaming rejects more than 100 keyterms per session", () => {
    expect(ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET.maxEntries).toBe(100);
    expect(ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET.maxTermLength).toBe(50);
  });

  it("ElevenLabs batch keyterms respect the 50-character and 5-word limits", () => {
    expect(ELEVENLABS_BATCH_KEYTERMS_BUDGET.maxTermLength).toBe(50);
    expect(ELEVENLABS_BATCH_KEYTERMS_BUDGET.maxWordsPerTerm).toBe(5);
  });

  it("ElevenLabs realtime keyterms stay within 50 terms of 20 characters", () => {
    expect(ELEVENLABS_REALTIME_KEYTERMS_BUDGET.maxEntries).toBe(50);
    expect(ELEVENLABS_REALTIME_KEYTERMS_BUDGET.maxTermLength).toBe(20);
  });

  it("Azure phrase lists document a 500-phrase maximum", () => {
    expect(AZURE_PHRASE_LIST_BUDGET.maxEntries).toBe(500);
  });
});

describe("buildLocalizedTranscriptionPrompt", () => {
  const state = {} as Parameters<
    typeof buildLocalizedTranscriptionPrompt
  >[0]["state"];

  it("includes glossary sources in the localized prompt", () => {
    const result = buildLocalizedTranscriptionPrompt({
      entries: { sources: ["Soniya", "Ralf"], replacements: [] },
      dictationLanguage: "en",
      state,
    });
    expect(result).toContain("Soniya, Ralf");
    expect(result).toContain("Consider this glossary");
  });

  it("caps the glossary so the whisper initial_prompt stays within its token budget", () => {
    const manyTerms = Array.from(
      { length: 200 },
      (_, i) => `dictionaryterm${i}`,
    );
    const result = buildLocalizedTranscriptionPrompt({
      entries: { sources: manyTerms, replacements: [] },
      dictationLanguage: "en",
      state,
    });
    // 650 characters of terms + separators + the fixed instruction text,
    // keeping the whole prompt under whisper's ~224-token prompt ceiling.
    expect(result.length).toBeLessThan(900);
    expect(result).not.toContain("dictionaryterm150");
  });
});

describe("buildPostProcessingPrompt", () => {
  it("substitutes variables in template config", () => {
    const result = buildPostProcessingPrompt(
      makeInput({
        kind: "template",
        promptTemplate:
          "User <username/> said: <transcript/>. Respond in <language/>.",
      }),
    );
    expect(result).toContain(
      "User Alice said: Hello world. Respond in English.",
    );
  });

  it("substitutes multiple occurrences of the same variable", () => {
    const result = buildPostProcessingPrompt(
      makeInput(
        {
          kind: "template",
          promptTemplate: "<username/> (<username/>) wrote: <transcript/>",
        },
        { transcript: "test", userName: "Bob", dictationLanguage: "fr" },
      ),
    );
    expect(result).toContain("Bob (Bob) wrote: test");
  });

  it("uses standard prompt structure for style config", () => {
    const result = buildPostProcessingPrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    expect(result).toContain("<transcript>");
    expect(result).toContain("Hello world");
    expect(result).toContain(
      "Process the transcript according to the instructions",
    );
  });

  it("appends the humanize skill to every post-processing prompt", () => {
    const template = buildPostProcessingPrompt(
      makeInput({
        kind: "template",
        promptTemplate: "Process: <transcript/>",
      }),
    );
    const style = buildPostProcessingPrompt(
      makeInput({ kind: "style", stylePrompt: "Be formal" }),
    );
    for (const result of [template, style]) {
      expect(result).toContain("Humanize the text");
      expect(result).toContain("em-dashes");
      expect(result).toContain("Do NOT alter code, data, or structured output");
    }
  });
});
