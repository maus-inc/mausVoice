import { describe, expect, it } from "vitest";
import {
  applyTranscriptionEdits,
  extractJsonFromMarkdown,
  isLikelyTruncatedJson,
  MAX_TRANSCRIPTION_EDITS,
  parsePostProcessingJson,
  resolveProcessedTranscription,
} from "./ai.utils";

describe("extractJsonFromMarkdown", () => {
  describe("Standard JSON Code Blocks", () => {
    it("should extract content from ```json code block", () => {
      const input = `\`\`\`json
{"name": "test"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle ```json code block with extra blank lines", () => {
      const input = `\`\`\`json


{"name": "test"}


\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle complex JSON objects", () => {
      const input = `\`\`\`json
{
  "name": "John",
  "age": 30,
  "hobbies": ["reading", "coding"]
}
\`\`\``;
      const expected = `{
  "name": "John",
  "age": 30,
  "hobbies": ["reading", "coding"]
}`;
      expect(extractJsonFromMarkdown(input)).toBe(expected);
    });
  });

  describe("Regular Code Blocks", () => {
    it("should extract content from ``` code block without json marker", () => {
      const input = `\`\`\`
{"name": "test"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle single-line code block", () => {
      const input = `\`\`\`{"name": "test"}\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });
  });

  describe("Inline Code Blocks", () => {
    it("should extract inline code", () => {
      const input = '`{"name": "test"}`';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should extract inline code with surrounding text", () => {
      const input = 'Here is the JSON: `{"name": "test"}` for you';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });
  });

  describe("Multiple Code Blocks", () => {
    it("should extract only the first code block", () => {
      const input = `\`\`\`json
{"first": 1}
\`\`\`
\`\`\`json
{"second": 2}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"first": 1}');
    });

    it("should extract only the first inline code block", () => {
      const input = '`{"first": 1}` and `{"second": 2}`';
      expect(extractJsonFromMarkdown(input)).toBe('{"first": 1}');
    });

    it("should handle mixed block and inline codes", () => {
      const input = `\`\`\`json
{"block": 1}
\`\`\`
 and \`{"inline": 2}\` and \`\`\`json
{"block2": 3}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"block": 1}');
    });
  });

  describe("Plain Text Without Markdown", () => {
    it("should return original text with whitespace trimmed", () => {
      const input = '  {"name": "test"}';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should return plain JSON string", () => {
      const input = '{"name": "test"}';
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle empty string", () => {
      expect(extractJsonFromMarkdown("")).toBe("");
    });

    it("should handle whitespace-only string", () => {
      expect(extractJsonFromMarkdown("   ")).toBe("");
    });
  });

  describe("LLM Output Formats", () => {
    it("should extract JSON from LLM output with explanation", () => {
      const input = `Here's the JSON you requested:

\`\`\`json
{"name": "test", "value": 42}
\`\`\`

This JSON object contains the requested data.`;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"name": "test", "value": 42}',
      );
    });

    it("should extract JSON from LLM output with prefix", () => {
      const input = `Based on your request, here is the result:
\`\`\`json
{"result": "success"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"result": "success"}');
    });

    it("should extract first JSON from multiple codeblocks in LLM output", () => {
      const input = `Here are some examples:

Example 1:
\`\`\`json
{"example": "first"}
\`\`\`

Example 2:
\`\`\`json
{"example": "second"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"example": "first"}');
    });

    it("should extract JSON from LLM output with markdown formatting", () => {
      const input = `**Response:**

\`\`\`json
{"data": "value"}
\`\`\`

*End of response*`;
      expect(extractJsonFromMarkdown(input)).toBe('{"data": "value"}');
    });
  });

  describe("Edge Cases", () => {
    it("should prefer code block over inline code", () => {
      const input = '`{"inline": 1}` and ```json\n{"block": 2}\n```';
      expect(extractJsonFromMarkdown(input)).toBe('{"block": 2}');
    });

    it("should handle nested markdown text", () => {
      const input = `Some **bold** text with \`{"data": "value"}\` inline code`;
      expect(extractJsonFromMarkdown(input)).toBe('{"data": "value"}');
    });

    it("should skip inline code that doesn't look like JSON", () => {
      const input = "Text with `single backticks` but no code";
      expect(extractJsonFromMarkdown(input)).toBe(input.trim());
    });

    it("should skip non-JSON inline code and return raw text", () => {
      const input = "Some text with `startDictationRecording` and more text";
      expect(extractJsonFromMarkdown(input)).toBe(input.trim());
    });

    it("should extract array format", () => {
      const input = `\`\`\`json
[1, 2, 3]
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe("[1, 2, 3]");
    });

    it("should handle special characters", () => {
      const input = `\`\`\`json
{"text": "Hello\\nWorld\\t!"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"text": "Hello\\nWorld\\t!"}',
      );
    });

    it("should handle no newline at start", () => {
      const input = `\`\`\`json{"name": "test"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle no newline at end", () => {
      const input = `\`\`\`json
{"name": "test"}\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle multiple inline codes", () => {
      const input = '`{"a": 1}` middle `{"b": 2}` end';
      expect(extractJsonFromMarkdown(input)).toBe('{"a": 1}');
    });

    it("should handle whitespace in inline code", () => {
      const input = '`{ "name" : "test" }`';
      expect(extractJsonFromMarkdown(input)).toBe('{ "name" : "test" }');
    });

    it("should handle deeply nested brackets", () => {
      const input = `\`\`\`json
{
  "level1": {
    "level2": {
      "level3": {
        "data": [1, 2, [3, 4, [5]]]
      }
    }
  }
}
\`\`\``;
      const expected = `{
  "level1": {
    "level2": {
      "level3": {
        "data": [1, 2, [3, 4, [5]]]
      }
    }
  }
}`;
      expect(extractJsonFromMarkdown(input)).toBe(expected);
    });

    it("should extract first codeblock when multiple on same line", () => {
      const input = '```json {"first": 1}``` text ```json {"second": 2}```';
      expect(extractJsonFromMarkdown(input)).toBe('{"first": 1}');
    });
  });

  describe("Unicode and Special Characters", () => {
    it("should handle emoji in JSON", () => {
      const input = `\`\`\`json
{"message": "Hello 🌍🚀", "emoji": "😀"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"message": "Hello 🌍🚀", "emoji": "😀"}',
      );
    });

    it("should handle Chinese characters", () => {
      const input = `\`\`\`json
{"name": "测试", "description": "这是一个测试"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"name": "测试", "description": "这是一个测试"}',
      );
    });

    it("should handle Arabic and RTL text", () => {
      const input = `\`\`\`json
{"text": "مرحبا بالعالم", "hebrew": "שלום עולם"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"text": "مرحبا بالعالم", "hebrew": "שלום עולם"}',
      );
    });

    it("should handle escaped unicode sequences", () => {
      const input = `\`\`\`json
{"unicode": "\\u4e2d\\u6587", "emoji": "\\ud83d\\ude00"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"unicode": "\\u4e2d\\u6587", "emoji": "\\ud83d\\ude00"}',
      );
    });

    it("should handle special whitespace characters", () => {
      const input = `\`\`\`json
{"nbsp": "a\\u00a0b", "emsp": "c\\u2003d"}
\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe(
        '{"nbsp": "a\\u00a0b", "emsp": "c\\u2003d"}',
      );
    });
  });

  describe("Line Endings", () => {
    it("should handle CRLF (Windows) line endings", () => {
      const input = `\`\`\`json\r\n{"name": "test"}\r\n\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle CR (old Mac) line endings", () => {
      const input = `\`\`\`json\r{"name": "test"}\r\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });

    it("should handle mixed line endings", () => {
      const input = `\`\`\`json\r\n{"name": "test"}\n\`\`\``;
      expect(extractJsonFromMarkdown(input)).toBe('{"name": "test"}');
    });
  });

  describe("Known Limitations", () => {
    it("known limitation: cannot handle backticks inside code block (regex limitation)", () => {
      const input = `\`\`\`json
{
  "code": "value with \`\`\` backticks",
  "valid": true
}
\`\`\``;
      const result = extractJsonFromMarkdown(input);
      expect(result).toContain('"code": "value with');
    });

    it("known limitation: inline code stops at escaped backtick", () => {
      const input = '`{"text": "value with \\` backtick"}`';
      const result = extractJsonFromMarkdown(input);
      expect(result).toContain('{"text": "value with \\');
    });
  });
});

describe("applyTranscriptionEdits", () => {
  it("applies edits in order against the evolving text", () => {
    const result = applyTranscriptionEdits("um so we should ah ship it", [
      { find: "um ", replace: "" },
      { find: " ah", replace: "" },
      { find: "ship it", replace: "ship it Friday" },
    ]);

    expect(result).toEqual({
      text: "so we should ship it Friday",
      applied: 3,
      skipped: 0,
    });
  });

  it("skips edits whose find text is absent or ambiguous", () => {
    const transcript = "the cat sat on the mat, the cat";
    const result = applyTranscriptionEdits(transcript, [
      { find: "cat", replace: "dog" },
      { find: "the mat", replace: "the rug" },
      { find: "not in the transcript", replace: "x" },
    ]);

    // "cat" appears twice, so replacing either occurrence could corrupt the
    // dictation; only the unique match is applied.
    expect(result.text).toBe("the cat sat on the rug, the cat");
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("skips an empty find instead of looping", () => {
    const result = applyTranscriptionEdits("hello", [
      { find: "", replace: "x" },
    ]);

    expect(result).toMatchObject({ text: "hello", applied: 0, skipped: 1 });
  });

  it("skips a find that lands inside a word", () => {
    // "can" is unique here, but it is the head of "cannot". Applying it would
    // splice the dictation into "couldnot" with nothing to show for it.
    const result = applyTranscriptionEdits("I cannot attend the meeting", [
      { find: "can", replace: "could" },
    ]);

    expect(result).toMatchObject({
      text: "I cannot attend the meeting",
      applied: 0,
      skipped: 1,
    });
  });

  it("skips a find that starts or ends inside a word", () => {
    const transcript = "he could not come";
    const result = applyTranscriptionEdits(transcript, [
      // Starts inside "could".
      { find: "ould", replace: "might" },
      // Starts on a boundary but ends inside "could".
      { find: "co", replace: "will" },
    ]);

    expect(result).toMatchObject({
      text: transcript,
      applied: 0,
      skipped: 2,
    });
  });

  it("applies a find that spans whole words", () => {
    const result = applyTranscriptionEdits("he could not come", [
      { find: "could", replace: "can" },
    ]);

    expect(result).toMatchObject({
      text: "he can not come",
      applied: 1,
      skipped: 0,
    });
  });

  it("applies a find that carries a leading space or trailing punctuation", () => {
    // The prompt tells the model to include the surrounding space in "find"
    // when deleting a word, so a match that ends on punctuation is a normal
    // request and not a mid-word one.
    const result = applyTranscriptionEdits("the cat sat on the mat, ok", [
      { find: " the mat,", replace: " the rug," },
    ]);

    expect(result).toMatchObject({
      text: "the cat sat on the rug, ok",
      applied: 1,
      skipped: 0,
    });
  });

  it("skips an edit that arrived without replacement text", () => {
    // A missing "replace" is not a deletion the model asked for. Reading it
    // as one removes the dictated text and leaves the user with no warning.
    const result = applyTranscriptionEdits("the meeting is at noon", [
      { find: "the meeting", replace: null },
    ]);

    expect(result).toMatchObject({
      text: "the meeting is at noon",
      applied: 0,
      skipped: 1,
    });
  });

  it("still deletes text when the model sends an empty replacement", () => {
    const result = applyTranscriptionEdits("the meeting is at noon", [
      { find: "the meeting ", replace: "" },
    ]);

    expect(result).toMatchObject({
      text: "is at noon",
      applied: 1,
      skipped: 0,
    });
  });

  it("caps the number of edits it will apply", () => {
    const edits = Array.from({ length: MAX_TRANSCRIPTION_EDITS + 2 }, () => ({
      find: "a",
      replace: "a",
    }));

    const result = applyTranscriptionEdits("a b c", edits);

    expect(result.applied).toBe(MAX_TRANSCRIPTION_EDITS);
    expect(result.skipped).toBe(2);
  });
});

describe("resolveProcessedTranscription", () => {
  // The warning names every reason an edit cannot apply, so no skipped or
  // unread entry is a silent no-op.
  const SKIP_RULE =
    " (an edit only applies when it names find text as a string, its replacement is a string, and that find text matches the transcript exactly once, on the edges of a word).";
  const ONE_EDIT_SKIPPED = `Applied 0 of 1 post-processing edits; 1 could not be applied${SKIP_RULE}`;
  const ONE_OF_TWO_EDITS_SKIPPED = `Applied 1 of 2 post-processing edits; 1 could not be applied${SKIP_RULE}`;

  it("applies edits and reports skipped ones as a warning", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        edits: [
          { find: "gonna", replace: "going to" },
          { find: "missing phrase", replace: "x" },
        ],
        result: "",
      }),
      "we are gonna ship",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "we are going to ship",
      warning: ONE_OF_TWO_EDITS_SKIPPED,
    });
  });

  it("notes the edit cap when a reply exceeds it", () => {
    const edits = Array.from(
      { length: MAX_TRANSCRIPTION_EDITS + 1 },
      (_, index) => ({ find: `w${index}`, replace: `w${index}` }),
    );
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits, result: "" }),
      "w0 w1",
    );

    expect(resolution).toMatchObject({
      status: "cleaned",
      transcript: "w0 w1",
    });
    if (resolution.status === "cleaned") {
      expect(resolution.warning).toContain(
        `Only the first ${MAX_TRANSCRIPTION_EDITS} edits were attempted.`,
      );
    }
  });

  it("keeps the rewrite when no edit matched", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        edits: [{ find: "not present", replace: "x" }],
        result: "We are going to ship.",
      }),
      "we are gonna ship",
    );

    // The rewrite covers the skipped edit, so there is nothing to warn about:
    // the cleaned text was still produced.
    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "We are going to ship.",
      warning: null,
    });
  });

  it("unwraps one level of schema-name nesting", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        transcription_cleaning: {
          edits: [{ find: "raw", replace: "cleaned" }],
          result: "",
        },
      }),
      "raw text",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "cleaned text",
      warning: null,
    });
  });

  it.each(["null", "42", "true", "{}"])(
    "skips an edit whose replacement is not a string: %s",
    (replace) => {
      const resolution = resolveProcessedTranscription(
        JSON.stringify({
          edits: [{ find: "uh ", replace: JSON.parse(replace) }],
        }),
        "uh so anyway",
      );

      // A non-string replacement is a provider dropping the key, not the model
      // asking to delete "uh ", so the edit is skipped and counted. Reading it
      // as a deletion used to remove the word and report a clean success.
      expect(resolution).toEqual({
        status: "cleaned",
        transcript: "uh so anyway",
        warning: ONE_EDIT_SKIPPED,
      });
    },
  );

  it("keeps the transcript when an edit arrives without a replacement", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [{ find: "the meeting" }], result: "" }),
      "the meeting is at noon",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "the meeting is at noon",
      warning: ONE_EDIT_SKIPPED,
    });
  });

  it("applies the valid edits of a reply that also carries an unusable one", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        edits: [
          { find: "gonna", replace: "going to" },
          { find: "the meeting" },
        ],
        result: "",
      }),
      "we are gonna join the meeting",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "we are going to join the meeting",
      warning: ONE_OF_TWO_EDITS_SKIPPED,
    });
  });

  it("skips a mid-word find and applies the whole-word edit beside it", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        edits: [
          { find: "can", replace: "could" },
          { find: "tomorrow", replace: "next week" },
        ],
        result: "",
      }),
      "I cannot attend the meeting tomorrow",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "I cannot attend the meeting next week",
      warning: ONE_OF_TWO_EDITS_SKIPPED,
    });
  });

  it("reports a reply that carries neither an edit list nor a rewrite", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ result: "" }),
      "raw text",
    );

    expect(resolution).toEqual({
      status: "unusable",
      reason: "empty",
      warning:
        "Post-processing returned no usable text; kept the raw transcript. The reply may have been truncated at the model's token limit.",
    });
  });

  it("treats a no-change reply as clean instead of failed", () => {
    // Both keys are required by the schema, so this is the answer the model
    // gives when the tone already matches the speaker. Calling it a failure
    // blamed the model's token limit for a correct dictation.
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [], result: "" }),
      "I finished the report today",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "I finished the report today",
      warning: null,
    });
  });

  it("treats a no-change reply with a blank result as clean too", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [], result: "   " }),
      "I finished the report today",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "I finished the report today",
      warning: null,
    });
  });

  it("reports a reply whose edit list could not be read at all", () => {
    // The reply declared an edit, so the model asked for a change. Reading the
    // entry away and calling the result a clean no-op told the user nothing
    // while the change they asked for was lost.
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [{ find: 42, replace: "x" }], result: "" }),
      "I will send the report today",
    );

    expect(resolution).toEqual({
      status: "unusable",
      reason: "unreadable-edits",
      warning:
        "Post-processing returned edits that could not be read; kept the raw transcript. The reply may not match the shape the provider was asked for.",
    });
  });

  it.each([
    ["a non-string find", { find: 42, replace: "x" }],
    ["a missing find", { replace: "x" }],
    ["a null entry", null],
    ["a bare string", "gonna"],
  ])("reports an edit list holding %s", (_label, entry) => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [entry], result: "" }),
      "we are gonna ship",
    );

    expect(resolution).toMatchObject({
      status: "unusable",
      reason: "unreadable-edits",
    });
  });

  it("counts an unread entry beside the ones it did apply", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        edits: [
          { find: "gonna", replace: "going to" },
          { find: 42, replace: "x" },
        ],
        result: "",
      }),
      "we are gonna ship",
    );

    // The totals describe every entry the model sent, so the unread one is
    // reported rather than quietly missing from the count.
    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "we are going to ship",
      warning: `Applied 1 of 2 post-processing edits; 1 could not be applied${SKIP_RULE}`,
    });
  });

  it("keeps the rewrite when the edit list beside it could not be read", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({
        edits: [{ find: 42, replace: "x" }],
        result: "We are going to ship.",
      }),
      "we are gonna ship",
    );

    // The rewrite carries the text the unread edit asked for, so there is
    // nothing left to report.
    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "We are going to ship.",
      warning: null,
    });
  });

  it("treats an empty transcript as clean instead of failed", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [], result: "" }),
      "   ",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "   ",
      warning: null,
    });
  });

  it("keeps the raw transcript when a truncated edit list cannot be repaired", () => {
    // The reply stops mid-edit, so no complete edit survived. The resolver
    // must not guess at partial edits: the raw transcript wins with a warning.
    const resolution = resolveProcessedTranscription(
      '{"edits":[{"find":"um ","replace":""},{"find":"gonna","replace":"going t',
      "um we are gonna ship it",
    );

    expect(resolution).toMatchObject({
      status: "unusable",
      reason: "unparseable",
    });
  });

  it("keeps the raw transcript when a reply is only missing its closing brace", () => {
    // Repairing a cut-off reply once turned it into a shorter transcript that
    // was pasted as a success, silently dropping the end of the dictation.
    // A reply that does not parse keeps the full raw transcript instead.
    const resolution = resolveProcessedTranscription(
      '{"edits":[],"result":"going to ship it"',
      "we are gonna ship it",
    );

    expect(resolution).toMatchObject({
      status: "unusable",
      reason: "unparseable",
    });
  });

  it("flags a non-JSON reply as unparseable", () => {
    const resolution = resolveProcessedTranscription(
      "Sure! Here is the cleaned text:",
      "raw text",
    );

    expect(resolution).toMatchObject({
      status: "unusable",
      reason: "unparseable",
    });
    if (resolution.status === "unusable") {
      expect(resolution.warning).toContain(
        "Failed to parse post-processing response",
      );
    }
  });
});

describe("parsePostProcessingJson", () => {
  it("parses complete JSON, including fenced blocks", () => {
    expect(parsePostProcessingJson('{"result":"Hello."}')).toEqual({
      result: "Hello.",
    });
    expect(parsePostProcessingJson('```json\n{"result":"Hi"}\n```')).toEqual({
      result: "Hi",
    });
  });

  it("rejects output cut off at the token limit instead of shortening it", () => {
    expect(() =>
      parsePostProcessingJson('{"result":"We agreed to push the beta to'),
    ).toThrow(SyntaxError);
    expect(() => parsePostProcessingJson('{"result":"Done."')).toThrow(
      SyntaxError,
    );
  });
});

describe("isLikelyTruncatedJson", () => {
  it.each([
    '{"result":"We agreed to push the beta to',
    '```json\n{"result":"We agreed to push',
    '  {"result":"Done."  ',
    '{"result":"He said }',
    '{"result":"Use {braces} and \\"quotes\\" like }',
    '{"result":{"text":"Done."}',
  ])("flags an object that never closes: %s", (raw) => {
    expect(isLikelyTruncatedJson(raw)).toBe(true);
  });

  it.each([
    '{"result":"Done."}',
    '```json\n{"result":"Done."}\n```',
    "Sure, here is the cleaned text.",
    '{"result":"He said }"}',
    '{"result":"Done."} trailing words',
    "",
  ])("does not flag complete JSON or prose: %s", (raw) => {
    expect(isLikelyTruncatedJson(raw)).toBe(false);
  });
});
