// PR 219 evidence. Runs the PR base ("old:") and the branch ("new:") over
// fixed fixtures and writes reports/pr219/evidence.{json,md}.
// Run: node reports/pr219/harness/build.mjs && node node_modules/.cache/pr219-evidence.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import * as oldSpoken from "old:apps/desktop/src/utils/spoken-commands.utils";
import * as newSpoken from "new:apps/desktop/src/utils/spoken-commands.utils";
import * as oldHalluc from "old:apps/desktop/src/utils/hallucination.utils";
import * as newHalluc from "new:apps/desktop/src/utils/hallucination.utils";
import * as oldAi from "old:apps/desktop/src/utils/ai.utils";
import * as newAi from "new:apps/desktop/src/utils/ai.utils";
import * as oldPrompt from "old:apps/desktop/src/utils/prompt.utils";
import * as newPrompt from "new:apps/desktop/src/utils/prompt.utils";

const BASE = process.env.PR219_BASE ?? "d1f06ec";
const outDir = path.resolve(process.cwd(), "reports/pr219");

// 1. Spoken commands ------------------------------------------------------

type CommandCase = { input: string; expected: string; note?: string };

const LITERAL = [
  "The billing period ends on Friday.",
  "The sprint period ends Friday.",
  "The observation period lasted six weeks.",
  "During the period we saw strong growth.",
  "My period was late.",
  "A time period of rest.",
  "Each period has its own budget.",
  "The waiting period is thirty days.",
  "We're launching a new line today.",
  "Can you read the next line for me?",
  "Write a new paragraph about pricing.",
  "Put a comma after the name.",
  "Remove that comma.",
  "I always use the Oxford comma.",
  "Where does the question mark go?",
  "Add a semicolon there.",
  "The colon is part of the large intestine.",
  "He was diagnosed with colon cancer.",
  "We need a new line of credit.",
  "That was a full stop for the project.",
  "Let's scratch that idea and start over.",
  "I'll scratch that off my list.",
  "We should scratch that from the agenda.",
];

const COMMANDS: CommandCase[] = [
  { input: "first item new line second item", expected: "first item\nsecond item" },
  { input: "Hello comma world", expected: "Hello, world" },
  { input: "That is final period", expected: "That is final." },
  { input: "I'm done period See you", expected: "I'm done. See you" },
  { input: "Send it today period", expected: "Send it today." },
  { input: "call me tomorrow full stop", expected: "call me tomorrow." },
  { input: "Stop period next line Go", expected: "Stop.\nGo" },
  { input: "Is it ready question mark", expected: "Is it ready?" },
  { input: "Note colon bring snacks", expected: "Note: bring snacks" },
  {
    input: "Hello world scratch that new paragraph Goodbye",
    expected: "\n\nGoodbye",
  },
  { input: "Hello world scratch that period", expected: "." },
  {
    input: "hello period how are you",
    expected: "hello. how are you",
    note: "Command spoken mid-sentence with no pause. Ambiguous with the noun; the new rule reads it as the noun.",
  },
];

const runSpoken = () => {
  const rows = [
    ...LITERAL.map((input) => ({ kind: "literal", input, expected: input })),
    ...COMMANDS.map((c) => ({ kind: "command", ...c })),
  ].map((row) => {
    const before = oldSpoken.applySpokenCommands(row.input, "en");
    const after = newSpoken.applySpokenCommands(row.input, "en");
    return {
      ...row,
      before,
      after,
      beforeOk: before === row.expected,
      afterOk: after === row.expected,
    };
  });
  const count = (kind: string, key: "beforeOk" | "afterOk") =>
    rows.filter((r) => r.kind === kind && r[key]).length;
  return {
    rows,
    summary: {
      literal: {
        total: LITERAL.length,
        before: count("literal", "beforeOk"),
        after: count("literal", "afterOk"),
      },
      command: {
        total: COMMANDS.length,
        before: count("command", "beforeOk"),
        after: count("command", "afterOk"),
      },
    },
  };
};

// 2. Segment silence gate + known-phrase filter -------------------------

type GateCase = {
  label: string;
  truth: "speech" | "hallucination";
  segments: { text: string; noSpeechProb?: number; avgLogprob?: number }[];
};

// Each case is one decode where the provider returned these segments. The
// transcript the pipeline starts from is the segments joined.
const GATE: GateCase[] = [
  {
    label: "Quiet opening after a pause, decoded confidently",
    truth: "speech",
    segments: [
      { text: "Can you send the report by Friday?", noSpeechProb: 0.93, avgLogprob: -0.25 },
    ],
  },
  {
    label: "Short reply at the end of a long pause",
    truth: "speech",
    segments: [{ text: "Yes, that works.", noSpeechProb: 0.91, avgLogprob: -0.4 }],
  },
  {
    label: "Soft-spoken name in a mostly silent window",
    truth: "speech",
    segments: [
      { text: "Meeting with Adaeze at noon.", noSpeechProb: 0.95, avgLogprob: -0.6 },
    ],
  },
  {
    label: "Ordinary speech, low no-speech probability",
    truth: "speech",
    segments: [{ text: "Let's ship it on Monday.", noSpeechProb: 0.05, avgLogprob: -0.2 }],
  },
  {
    label: "Unsure decode of silence",
    truth: "hallucination",
    segments: [{ text: "Thank you.", noSpeechProb: 0.97, avgLogprob: -1.3 }],
  },
  {
    label: "Canonical hallucination, decoded confidently",
    truth: "hallucination",
    segments: [{ text: "Thank you for watching!", noSpeechProb: 0.96, avgLogprob: -0.2 }],
  },
  {
    label: "Subtitle credit, decoded confidently",
    truth: "hallucination",
    segments: [
      { text: "Subtitles by the Amara.org community", noSpeechProb: 0.98, avgLogprob: -0.15 },
    ],
  },
  {
    label: "Confident hallucination not on the known-phrase list",
    truth: "hallucination",
    segments: [
      { text: "I'll see you in the next video.", noSpeechProb: 0.95, avgLogprob: -0.35 },
    ],
  },
  {
    label: "Confident 'Thanks.' on silence (not on the list)",
    truth: "hallucination",
    segments: [{ text: "Thanks.", noSpeechProb: 0.92, avgLogprob: -0.5 }],
  },
  {
    label: "Provider without avg_logprob, silent window",
    truth: "hallucination",
    segments: [{ text: "Bye.", noSpeechProb: 0.95 }],
  },
  {
    label: "Speech then trailing silence hallucination",
    truth: "speech",
    segments: [
      { text: "Please call me back.", noSpeechProb: 0.1, avgLogprob: -0.3 },
      { text: " Thank you for watching!", noSpeechProb: 0.94, avgLogprob: -0.25 },
    ],
  },
];

const runGate = () => {
  const rows = GATE.map((c) => {
    const raw = c.segments.map((s) => s.text).join("");
    const before = oldHalluc.applyHallucinationFiltering(raw, c.segments, "en", true);
    const after = newHalluc.applyHallucinationFiltering(raw, c.segments, "en", true);
    const gateOnlyAfter = newHalluc.gateSilentSegments(c.segments) ?? raw;
    return { ...c, raw, before, after, gateOnlyAfter };
  });
  const hasSpeech = (r: (typeof rows)[number], out: string) =>
    r.truth === "speech" && out.trim().length > 0;
  const admitsHallucination = (r: (typeof rows)[number], out: string) =>
    r.truth === "hallucination" && out.trim().length > 0;
  const speechRows = rows.filter((r) => r.truth === "speech");
  const hallRows = rows.filter((r) => r.truth === "hallucination");
  return {
    rows,
    summary: {
      speechCases: speechRows.length,
      speechKeptBefore: speechRows.filter((r) => hasSpeech(r, r.before)).length,
      speechKeptAfter: speechRows.filter((r) => hasSpeech(r, r.after)).length,
      hallucinationCases: hallRows.length,
      hallucinationsShownBefore: hallRows.filter((r) => admitsHallucination(r, r.before)).length,
      hallucinationsShownAfter: hallRows.filter((r) => admitsHallucination(r, r.after)).length,
      passedGateButCaughtByPhraseFilter: hallRows.filter(
        (r) => r.gateOnlyAfter.trim() && !r.after.trim(),
      ).length,
    },
  };
};

// 3. Post-processing replies ---------------------------------------------

const TRANSCRIPT =
  "okay so for the launch we agreed to push the beta to october because the payments team needs two more weeks and marketing wants the new landing page live first then we do a soft launch to the waitlist and only after that the public announcement";
const CLEAN =
  "Okay, so for the launch, we agreed to push the beta to October because the payments team needs two more weeks, and marketing wants the new landing page live first. Then we do a soft launch to the waitlist, and only after that, the public announcement.";
const cut = (text: string, fraction: number) =>
  text.slice(0, Math.floor(text.length * fraction));

const REPLIES = [
  { label: "Complete JSON", raw: JSON.stringify({ result: CLEAN }) },
  {
    label: "Complete JSON in a code fence",
    raw: "```json\n" + JSON.stringify({ result: CLEAN }) + "\n```",
  },
  { label: "Cut off at 60%", raw: cut(JSON.stringify({ result: CLEAN }), 0.6) },
  { label: "Cut off at 90%", raw: cut(JSON.stringify({ result: CLEAN }), 0.9) },
  {
    label: "Fenced, cut off before the closing fence",
    raw: cut("```json\n" + JSON.stringify({ result: CLEAN }) + "\n```", 0.7),
  },
];

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

const pasted = (parse: (raw: string) => unknown, raw: string) => {
  try {
    const parsed = parse(raw) as { result?: unknown };
    return typeof parsed?.result === "string"
      ? { text: parsed.result.trim(), warning: null as string | null }
      : { text: TRANSCRIPT, warning: "validation failed" };
  } catch {
    return {
      text: TRANSCRIPT,
      warning: newAi.isLikelyTruncatedJson(raw)
        ? "parse failed; truncation hint shown"
        : "parse failed",
    };
  }
};

const runReplies = () =>
  REPLIES.map((r) => {
    const before = pasted(oldAi.parsePostProcessingJson, r.raw);
    const after = pasted(newAi.parsePostProcessingJson, r.raw);
    return {
      label: r.label,
      rawChars: r.raw.length,
      before: { ...before, words: wordCount(before.text) },
      after: { ...after, words: wordCount(after.text) },
      spokenWords: wordCount(TRANSCRIPT),
    };
  });

// 4. Output-token budget ---------------------------------------------------

const BUDGET_WORDS = ["we", "agreed", "to", "push", "the", "beta"];

const runBudget = () =>
  [20, 100, 250, 500, 1000, 1500, 2000, 3000].map((words) => {
    const transcript = Array.from(
      { length: words },
      (_, i) => BUDGET_WORDS[i % BUDGET_WORDS.length],
    ).join(" ");
    const estimate = newPrompt.estimateTokenCount(transcript);
    return {
      words,
      chars: transcript.length,
      estimatedTokens: Math.round(estimate),
      before: oldPrompt.POST_PROCESS_MAX_TOKENS,
      after: newPrompt.getPostProcessMaxTokens(transcript),
    };
  });

// 5. Local RMS gate (JS port of the Rust functions, old and new) ---------

const THRESHOLD = 0.0025;
const oldIsNearSilent = (samples: Float32Array) => {
  if (samples.length === 0) return true;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length) < THRESHOLD;
};
const newIsNearSilent = (samples: Float32Array, rate: number) => {
  const window = Math.max(1, Math.floor(rate * 0.3));
  for (let i = 0; i < samples.length; i += window) {
    const chunk = samples.subarray(i, i + window);
    let sum = 0;
    for (const s of chunk) sum += s * s;
    if (sum / chunk.length >= THRESHOLD * THRESHOLD) return false;
  }
  return true;
};

// Deterministic pseudo-noise so the table is reproducible.
const noise = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296 - 0.5;
};
const signal = (
  seconds: number,
  rate: number,
  parts: { from: number; to: number; amp: number }[],
  floor: number,
) => {
  const out = new Float32Array(Math.floor(seconds * rate));
  const rnd = noise(7);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let v = floor * rnd() * 2;
    for (const p of parts) {
      if (t >= p.from && t < p.to) {
        // Syllable-rate envelope over a 180 Hz carrier.
        const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
        v += p.amp * env * Math.sin(2 * Math.PI * 180 * t);
      }
    }
    out[i] = v;
  }
  return out;
};

const runRms = () => {
  const rate = 16_000;
  const cases = [
    { label: "Room tone only, 5 s", truth: "silence", s: signal(5, rate, [], 0.001) },
    {
      label: "Normal speech 2 s in 5 s",
      truth: "speech",
      s: signal(5, rate, [{ from: 1, to: 3, amp: 0.08 }], 0.001),
    },
    {
      label: "Quiet 'yes' 0.5 s at the end of 20 s",
      truth: "speech",
      s: signal(20, rate, [{ from: 19.3, to: 19.8, amp: 0.012 }], 0.0005),
    },
    {
      label: "Soft speech 1 s inside 30 s of hold",
      truth: "speech",
      s: signal(30, rate, [{ from: 12, to: 13, amp: 0.01 }], 0.0005),
    },
    {
      label: "Single click 10 ms in 5 s of room tone",
      truth: "silence",
      s: signal(5, rate, [{ from: 2, to: 2.01, amp: 0.05 }], 0.001),
    },
  ];
  return cases.map((c) => ({
    label: c.label,
    truth: c.truth,
    beforeGated: oldIsNearSilent(c.s),
    afterGated: newIsNearSilent(c.s, rate),
  }));
};

// Output -------------------------------------------------------------------

const results = {
  base: BASE,
  spokenCommands: runSpoken(),
  silenceGate: runGate(),
  postProcessingReplies: runReplies(),
  outputTokenBudget: runBudget(),
  localRmsGate: runRms(),
};

writeFileSync(path.join(outDir, "evidence.json"), JSON.stringify(results, null, 2) + "\n");

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
const md: string[] = [];
const sc = results.spokenCommands;
md.push(
  `## Spoken commands`,
  "",
  `Base \`${BASE}\` vs this branch, English. Correct means the output equals the hand-written expectation.`,
  "",
  `| Set | Cases | Correct before | Correct after |`,
  `| --- | --- | --- | --- |`,
  `| Ordinary speech (must stay literal) | ${sc.summary.literal.total} | ${sc.summary.literal.before} | ${sc.summary.literal.after} |`,
  `| Intended commands | ${sc.summary.command.total} | ${sc.summary.command.before} | ${sc.summary.command.after} |`,
  "",
  `<details><summary>Every case</summary>`,
  "",
  `| Input | Expected | Before | After |`,
  `| --- | --- | --- | --- |`,
  ...sc.rows.map(
    (r) =>
      `| ${esc(r.input)} | ${esc(r.expected)} | ${r.beforeOk ? "ok" : "`" + esc(r.before) + "`"} | ${r.afterOk ? "ok" : "`" + esc(r.after) + "`"} |`,
  ),
  "",
  `</details>`,
  "",
);
const g = results.silenceGate;
md.push(
  `## Segment silence gate`,
  "",
  `The full \`applyHallucinationFiltering\` pipeline (probability gate, then the known-phrase filter), old vs new, on the same segments.`,
  "",
  `| | Before | After |`,
  `| --- | --- | --- |`,
  `| Speech cases with words kept (of ${g.summary.speechCases}) | ${g.summary.speechKeptBefore} | ${g.summary.speechKeptAfter} |`,
  `| Hallucination cases that reach the user (of ${g.summary.hallucinationCases}) | ${g.summary.hallucinationsShownBefore} | ${g.summary.hallucinationsShownAfter} |`,
  "",
  `${g.summary.passedGateButCaughtByPhraseFilter} confident hallucinations pass the new gate and are then removed by the known-phrase filter.`,
  "",
  `<details><summary>Every case</summary>`,
  "",
  `| Case | Truth | no_speech_prob / avg_logprob | Before | After |`,
  `| --- | --- | --- | --- | --- |`,
  ...g.rows.map(
    (r) =>
      `| ${r.label} | ${r.truth} | ${r.segments.map((s) => `${s.noSpeechProb ?? "-"} / ${s.avgLogprob ?? "-"}`).join("; ")} | \`${esc(r.before) || "(empty)"}\` | \`${esc(r.after) || "(empty)"}\` |`,
  ),
  "",
  `</details>`,
  "",
);
md.push(
  `## Post-processing replies`,
  "",
  `What gets pasted for a ${wordCount(TRANSCRIPT)}-word dictation when the model reply is complete or cut off.`,
  "",
  `| Reply | Before: words pasted | After: words pasted | After: warning |`,
  `| --- | --- | --- | --- |`,
  ...results.postProcessingReplies.map(
    (r) =>
      `| ${r.label} | ${r.before.words}${r.before.text === TRANSCRIPT ? " (raw)" : ""} | ${r.after.words}${r.after.text === TRANSCRIPT ? " (raw)" : ""} | ${r.after.warning ?? "none"} |`,
  ),
  "",
);
md.push(
  `## Output-token budget`,
  "",
  `| Words | Estimated tokens | Before | After |`,
  `| --- | --- | --- | --- |`,
  ...results.outputTokenBudget.map(
    (r) => `| ${r.words} | ${r.estimatedTokens} | ${r.before} | ${r.after} |`,
  ),
  "",
);
md.push(
  `## Local RMS gate (JS port)`,
  "",
  `Gated means the clip is treated as silence and never transcribed.`,
  "",
  `| Clip (16 kHz, synthetic) | Truth | Gated before | Gated after |`,
  `| --- | --- | --- | --- |`,
  ...results.localRmsGate.map(
    (r) => `| ${r.label} | ${r.truth} | ${r.beforeGated ? "yes" : "no"} | ${r.afterGated ? "yes" : "no"} |`,
  ),
  "",
);
writeFileSync(path.join(outDir, "evidence.generated.md"), md.join("\n"));
console.log(JSON.stringify({ spoken: sc.summary, gate: g.summary }, null, 2));
