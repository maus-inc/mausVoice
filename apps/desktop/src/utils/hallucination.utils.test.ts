import { describe, expect, it } from "vitest";
import {
  applyHallucinationFiltering,
  filterKnownSilenceHallucinations,
  gateSilentSegments,
  isKnownSilenceHallucination,
  joinKeptSegmentTexts,
  markSilentSegmentAudio,
} from "./hallucination.utils";

describe("silence hallucination filtering", () => {
  it("recognizes common silence-only output", () => {
    expect(isKnownSilenceHallucination(" Thank you for watching. ")).toBe(true);
    expect(filterKnownSilenceHallucinations("[BLANK_AUDIO]")).toBe("");
  });

  it("does not remove a phrase embedded in real speech", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Thank you for watching the demo, and please send feedback.",
      ),
    ).toContain("Thank you for watching the demo");
  });

  it("preserves short genuine sentences that resemble old silence entries", () => {
    expect(filterKnownSilenceHallucinations("You.")).toBe("You.");
    expect(filterKnownSilenceHallucinations("The end.")).toBe("The end.");
  });

  it("strips the cloud subtitle credit and its fabricated sign-off", () => {
    expect(
      filterKnownSilenceHallucinations("Subtitles by the Amara.org community"),
    ).toBe("");
    expect(
      filterKnownSilenceHallucinations("Subtitles by the Amara.org community."),
    ).toBe("");
    expect(
      filterKnownSilenceHallucinations(
        "Ship the fix today. Subtitles by the Amara.org community.\nBest regards.",
      ),
    ).toBe("Ship the fix today.");
  });

  it("keeps a sign-off that is part of a real sentence", () => {
    expect(filterKnownSilenceHallucinations("Best regards, Alice")).toBe(
      "Best regards, Alice",
    );
    expect(
      filterKnownSilenceHallucinations("Send my best regards to the team."),
    ).toBe("Send my best regards to the team.");
  });

  it("leaves cloud hallucinations alone for sentinels and non-English", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Subtitles by the Amara.org community.",
        "primary",
      ),
    ).toBe("Subtitles by the Amara.org community.");
    expect(
      filterKnownSilenceHallucinations("Thank you for watching.", "auto"),
    ).toBe("Thank you for watching.");
  });

  it("leaves cloud hallucinations alone for non-English dictation", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Subtitles by the Amara.org community.",
        "de",
      ),
    ).toBe("Subtitles by the Amara.org community.");
  });

  it("does not collapse blank lines or indentation when nothing is filtered", () => {
    expect(filterKnownSilenceHallucinations("Hello\n\n  indented")).toBe(
      "Hello\n\n  indented",
    );
  });

  it("preserves paragraph breaks around a stripped hallucination line", () => {
    expect(
      filterKnownSilenceHallucinations(
        "Ship the fix today.\nThank you for watching.\nNext paragraph.",
      ),
    ).toBe("Ship the fix today.\nNext paragraph.");
  });

  it("keeps a standalone genuine sign-off without an Amara credit", () => {
    expect(
      filterKnownSilenceHallucinations("Please review the doc. Best regards."),
    ).toBe("Please review the doc. Best regards.");
    expect(filterKnownSilenceHallucinations("Best regards.")).toBe(
      "Best regards.",
    );
  });
});

describe("applyHallucinationFiltering", () => {
  it("preserves the raw transcript exactly when the filter is disabled", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [{ text: "[BLANK_AUDIO]", noSpeechProb: 0.99 }];
    expect(applyHallucinationFiltering(raw, segments, "en", false)).toBe(raw);
  });

  it("drops high noSpeechProb segments for non-English and auto languages", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [
      { text: "Some speech.", noSpeechProb: 0.1 },
      { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "de", true)).toBe(
      "Some speech.",
    );
    expect(applyHallucinationFiltering(raw, segments, "auto", true)).toBe(
      "Some speech.",
    );
  });

  it("keeps the English phrase filter off for auto while probability gating stays on", () => {
    const raw = "Thank you for watching. Useful speech.";
    const segments = [
      { text: "Thank you for watching.", noSpeechProb: 0.1 },
      { text: "Useful speech.", noSpeechProb: 0.1 },
      { text: "model noise", noSpeechProb: 0.95 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "auto", true)).toBe(
      "Thank you for watching. Useful speech.",
    );
  });

  it("drops near-certain-silence segments when the filter is enabled", () => {
    const raw = "Some speech. [BLANK_AUDIO]";
    const segments = [
      { text: "Some speech.", noSpeechProb: 0.1 },
      { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
    ];
    expect(applyHallucinationFiltering(raw, segments, "en", true)).toBe(
      "Some speech.",
    );
  });

  it.each([
    {
      name: "leading-space boundaries",
      segments: [
        { text: "Hello", noSpeechProb: 0.1 },
        { text: " world", noSpeechProb: 0.99 },
        { text: " today", noSpeechProb: 0.1 },
      ],
      expected: "Hello today",
    },
    {
      name: "no boundary whitespace",
      segments: [
        { text: "Hello", noSpeechProb: 0.1 },
        { text: "world", noSpeechProb: 0.99 },
        { text: "today", noSpeechProb: 0.1 },
      ],
      expected: "Hello today",
    },
    {
      name: "mixed kept boundaries",
      segments: [
        { text: "Hello", noSpeechProb: 0.1 },
        { text: "noise", noSpeechProb: 0.99 },
        { text: "world", noSpeechProb: 0.1 },
        { text: " today", noSpeechProb: 0.1 },
      ],
      expected: "Hello world today",
    },
  ])(
    "rebuilds kept segments with pairwise spacing ($name)",
    ({ segments, expected }) => {
      expect(
        applyHallucinationFiltering("Hello world today", segments, "en", true),
      ).toBe(expected);
    },
  );

  it("treats newline as a boundary without inserting a space after it", () => {
    // Spoken "new line" can leave a trailing `\n` on a kept segment. Detection
    // uses `\s` so we do not emit `\n ` after the break.
    expect(joinKeptSegmentTexts(["Hello\n", "world"])).toBe("Hello\nworld");
    expect(
      applyHallucinationFiltering(
        "Hello\nnoise\nworld",
        [
          { text: "Hello\n", noSpeechProb: 0.1 },
          { text: "noise", noSpeechProb: 0.99 },
          { text: "world", noSpeechProb: 0.1 },
        ],
        "en",
        true,
      ),
    ).toBe("Hello\nworld");
  });

  it("treats NBSP as a boundary and does not collapse it to ASCII space", () => {
    const nbsp = "\u00a0";
    expect(joinKeptSegmentTexts([`Hello${nbsp}`, "world"])).toBe(
      `Hello${nbsp}world`,
    );
    expect(joinKeptSegmentTexts(["Hello", `${nbsp}world`])).toBe(
      `Hello${nbsp}world`,
    );
  });

  it("keeps a genuine standalone Best regards. sign-off under the filter", () => {
    const raw = "Please review the doc. Best regards.";
    expect(applyHallucinationFiltering(raw, undefined, "en", true)).toBe(
      "Please review the doc. Best regards.",
    );
  });
});

describe("gateSilentSegments decoder confidence", () => {
  it("keeps confidently decoded speech even when no_speech_prob is high", () => {
    const segments = [
      { text: "Hello", noSpeechProb: 0.1, avgLogprob: -0.3 },
      { text: " world", noSpeechProb: 0.95, avgLogprob: -0.2 },
    ];
    expect(gateSilentSegments(segments)).toBeNull();
    expect(
      applyHallucinationFiltering("Hello world", segments, "en", true),
    ).toBe("Hello world");
  });

  it("does not empty a whole window of confident speech", () => {
    expect(
      gateSilentSegments([
        { text: "Real speech", noSpeechProb: 0.97, avgLogprob: -0.4 },
        { text: " continues here", noSpeechProb: 0.97, avgLogprob: -0.5 },
      ]),
    ).toBeNull();
  });

  it("drops a high no_speech_prob segment the decoder was unsure about", () => {
    expect(
      gateSilentSegments([
        { text: "Real speech.", noSpeechProb: 0.1, avgLogprob: -0.3 },
        { text: " Thanks for watching!", noSpeechProb: 0.95, avgLogprob: -1.4 },
      ]),
    ).toBe("Real speech.");
  });

  it("falls back to the probability alone when avg_logprob is missing", () => {
    expect(
      gateSilentSegments([
        { text: "Real speech.", noSpeechProb: 0.1 },
        { text: " [BLANK_AUDIO]", noSpeechProb: 0.99 },
      ]),
    ).toBe("Real speech.");
  });
});

describe("segment audio energy", () => {
  const rate = 16_000;
  // Room tone everywhere, plus a quiet 180 Hz voice-like tone in `speech`.
  const audio = (seconds: number, speech: [number, number][] = []) => {
    const out = new Float32Array(seconds * rate);
    for (let i = 0; i < out.length; i++) {
      const t = i / rate;
      out[i] = 0.0005 * Math.sin(2 * Math.PI * 50 * t);
      if (speech.some(([from, to]) => t >= from && t < to)) {
        out[i] += 0.012 * Math.sin(2 * Math.PI * 180 * t);
      }
    }
    return out;
  };
  const confident = { noSpeechProb: 0.95, avgLogprob: -0.3 };

  it("drops a confident hallucination whose own audio is silent", () => {
    const segments = markSilentSegmentAudio(
      [
        {
          text: "Send it today.",
          noSpeechProb: 0.1,
          avgLogprob: -0.2,
          start: 0,
          end: 2,
        },
        {
          text: " I'll see you in the next video.",
          ...confident,
          start: 3,
          end: 5,
        },
      ],
      audio(6, [[0, 2]]),
      rate,
    );

    expect(segments?.[1]?.audioSilent).toBe(true);
    expect(applyHallucinationFiltering("", segments, "en", true)).toBe(
      "Send it today.",
    );
  });

  it("keeps quiet speech that the model flagged but decoded confidently", () => {
    const segments = markSilentSegmentAudio(
      [{ text: "Yes, that works.", ...confident, start: 19.3, end: 19.8 }],
      audio(20, [[19.3, 19.8]]),
      rate,
    );

    expect(segments?.[0]?.audioSilent).toBe(false);
    expect(gateSilentSegments(segments)).toBeNull();
  });

  it("widens the span so a slightly early timestamp still finds the speech", () => {
    const segments = markSilentSegmentAudio(
      [{ text: "Yes.", ...confident, start: 2, end: 2.5 }],
      audio(5, [[2.8, 3.2]]),
      rate,
    );

    expect(segments?.[0]?.audioSilent).toBe(false);
  });

  it.each([
    ["no timestamps", { text: "Thanks.", ...confident }],
    [
      "a span past the audio",
      { text: "Thanks.", ...confident, start: 30, end: 31 },
    ],
    ["an empty span", { text: "Thanks.", ...confident, start: 2, end: 2 }],
    [
      "a segment the model did not flag",
      {
        text: "Thanks.",
        noSpeechProb: 0.2,
        avgLogprob: -0.3,
        start: 1,
        end: 2,
      },
    ],
    [
      "an unsure segment the probability test already drops",
      {
        text: "Thanks.",
        noSpeechProb: 0.95,
        avgLogprob: -1.4,
        start: 1,
        end: 2,
      },
    ],
  ])("leaves %s unmeasured", (_label, segment) => {
    const [marked] = markSilentSegmentAudio([segment], audio(5), rate) ?? [];

    expect(marked).toBe(segment);
  });
});
