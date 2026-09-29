import { describe, expect, it } from "vitest";
import {
  applyTranscriptionEdits,
  extractJsonFromMarkdown,
  MAX_TRANSCRIPTION_EDITS,
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
      warning:
        "Applied 1 of 2 post-processing edits; 1 could not be applied (an edit only applies when its text matches the transcript exactly once).",
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

  it("tolerates a non-string replacement from JSON object mode", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [{ find: "uh ", replace: null }] }),
      "uh so anyway",
    );

    expect(resolution).toMatchObject({
      status: "cleaned",
      transcript: "so anyway",
    });
  });

  it("reports a reply with no usable text", () => {
    const resolution = resolveProcessedTranscription(
      JSON.stringify({ edits: [], result: "   " }),
      "raw text",
    );

    expect(resolution).toEqual({
      status: "unusable",
      reason: "empty",
      warning:
        "Post-processing returned no usable text; kept the raw transcript. The reply may have been truncated at the model's token limit.",
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

  it("still resolves a reply that only misses its closing brace", () => {
    const resolution = resolveProcessedTranscription(
      '{"edits":[],"result":"going to ship it"',
      "we are gonna ship it",
    );

    expect(resolution).toEqual({
      status: "cleaned",
      transcript: "going to ship it",
      warning: null,
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
