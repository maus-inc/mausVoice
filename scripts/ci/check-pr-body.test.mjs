import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const script = fileURLToPath(new URL("./check-pr-body.mjs", import.meta.url));
const template = fileURLToPath(
  new URL("../../.github/pull_request_template.md", import.meta.url),
);

function run(body, extraArgs = []) {
  const result = spawnSync(process.execPath, [script, "-", ...extraArgs], {
    input: body,
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const footer = "MausAgent | Filed by `model`, with `@human`, on `2026-11-05`";

describe("check-pr-body", () => {
  it("passes a folded body with a visible footer", () => {
    const body = [
      "## Summary",
      "The change and why it exists.",
      "",
      "<details>",
      "<summary>Review and babysit log</summary>",
      "",
      "| Round | Head SHA |",
      "| --- | --- |",
      "| 1 | `abc1234` |",
      "",
      "</details>",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("passes the repository template as written", () => {
    const { code, out } = run(readFileSync(template, "utf8"));
    assert.equal(code, 0, out);
  });

  it("fails a details block with no summary", () => {
    const body = [
      "## Summary",
      "Text.",
      "<details>",
      "| Round | 1 |",
      "</details>",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R1 line 4/);
  });

  it("passes a one-line details and summary, as bots append", () => {
    const body = [
      "## Summary",
      "Text.",
      "<details><summary><strong>Usage Guide</strong></summary>",
      "",
      "### Checking Your Pull Request",
      "Boilerplate.",
      "",
      "</details>",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("fails a nested details block with no summary", () => {
    const body = [
      "## Summary",
      "Text.",
      "<details>",
      "<summary>Review and babysit log</summary>",
      "",
      "<details>",
      "long explanation",
      "</details>",
      "",
      "</details>",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R1 line 7/);
  });

  it("ignores fold markup inside a fenced example", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "```md",
      "<details>",
      "no summary and never closed",
      "```",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("does not read a word that merely contains review as a review heading", () => {
    const body = ["## Summary", "Text.", "", "## Preview", "Text.", "", footer].join("\n");
    const { code, out } = run(body);
    // R6 rejects `## Preview` as an unknown visible section, but R3 must not claim it is a review record.
    assert.equal(code, 1);
    assert.doesNotMatch(out, /R3/);
    assert.match(out, /R6/);
  });

  it("fails a visible heading outside the template sections", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "## Deployment notes",
      "Text.",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R6 line 4/);
  });

  it("fails an unclosed details block", () => {
    const body = [
      "## Summary",
      "Text.",
      "<details>",
      "<summary>Review log</summary>",
      "| Round | 1 |",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R2/);
  });

  it("fails an unfolded review heading", () => {
    const body = [
      "## Summary",
      "Text.",
      "## Review rounds",
      "- round one",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R3 line 3/);
  });

  it("fails an unfolded babysit heading", () => {
    const body = [
      "## Summary",
      "Text.",
      "### Babysit polling",
      "- poll",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R3/);
  });

  it("fails an unfolded CI or log heading", () => {
    for (const heading of [
      "## CI logs",
      "## Check runs",
      "## Research notes",
    ]) {
      const body = ["## Summary", "Text.", heading, "- one", footer].join("\n");
      const { code } = run(body);
      assert.equal(code, 1, heading);
    }
  });

  it("fails a body that grows past the open line budget", () => {
    const body = [
      "## Summary",
      ...Array.from({ length: 12 }, (_, i) => `Line ${i} of prose.`),
      footer,
    ].join("\n");
    const { code, out } = run(body, ["--max-open", "5"]);
    assert.equal(code, 1);
    assert.match(out, /R4/);
  });

  it("fails a body with no footer", () => {
    const body = ["## Summary", "Text."].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R5/);
  });

  it("fails a footer hidden inside a fold", () => {
    const body = [
      "## Summary",
      "Text.",
      "<details>",
      "<summary>Review log</summary>",
      footer,
      "</details>",
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /footer line sits inside a fold/);
  });

  it("fails a duplicated footer", () => {
    const body = ["## Summary", "Text.", footer, footer].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /appears 2 times/);
  });

  it("ignores a <details> tag mentioned in inline code or a comment", () => {
    const body = [
      "## Summary",
      "A body that explains a `<details>` tag must not open one.",
      "<!-- <details> -->",
      "<details>",
      "<summary>Review log</summary>",
      "| Round | 1 |",
      "</details>",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("treats an empty body as a failure", () => {
    const { code } = run("   \n");
    assert.equal(code, 1);
  });

  it("rejects an unknown option with a usage exit code", () => {
    const { code, out } = run("x", ["--fold-everything"]);
    assert.equal(code, 2);
    assert.match(out, /unknown option/);
  });
});
