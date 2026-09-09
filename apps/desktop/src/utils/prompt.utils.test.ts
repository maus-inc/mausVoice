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
  ELEVENLABS_KEYTERMS_BUDGET,
  GLOSSARY_EXACT_SPELLING_INSTRUCTION,
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
    expect(spellings.length).toBeLessThanOrEqual(2_100);
    // The budget is 2,000 characters of rules, so the full 120-rule list
    // (over 3,900 characters) must be cut short.
    expect(spellings).not.toContain("src119");
    expect(spellings).toContain("src0");
  });
});

describe("glossary template variable", () => {
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

describe("provider budgets match documented API limits", () => {
  it("Deepgram stays under the documented 500-token keyterm total", () => {
    expect(DEEPGRAM_KEYTERM_BUDGET.maxEntries).toBe(100);
    expect(DEEPGRAM_KEYTERM_BUDGET.maxCharacters).toBeLessThanOrEqual(1500);
  });

  it("AssemblyAI streaming rejects more than 100 keyterms per session", () => {
    expect(ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET.maxEntries).toBe(100);
    expect(ASSEMBLYAI_STREAMING_KEYTERMS_BUDGET.maxTermLength).toBe(50);
  });

  it("ElevenLabs keyterms respect the 50-character and 5-word limits", () => {
    expect(ELEVENLABS_KEYTERMS_BUDGET.maxTermLength).toBe(50);
    expect(ELEVENLABS_KEYTERMS_BUDGET.maxWordsPerTerm).toBe(5);
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
