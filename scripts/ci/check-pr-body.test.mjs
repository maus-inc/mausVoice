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
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
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
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
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
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("does not read a word that merely contains review as a review heading", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "## Preview",
      "Text.",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    // R6 rejects `## Preview` as an unknown visible section, but R3 must not claim it is a review record.
    assert.equal(code, 1);
    assert.doesNotMatch(out, /R3/);
    assert.match(out, /R6/);
  });

  it("fails a body that drops the verification gate and the checklist", () => {
    const body = ["## Summary", "Text.", "", footer].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R7/);
    assert.match(out, /## Verification gate/);
  });

  it("fails an unfolded bullet that records a round", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "- Round 3: CI went red on the lint job.",
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] Every review and babysit record is folded, and the round log has one row per round.",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R8 line 4/);
    // A checklist item may talk about rounds without being one.
    assert.equal(out.match(/R8/g)?.length, 1, out);
  });

  it("tolerates a bold heading that a review bot wraps the body in", () => {
    const body = [
      "## **User description**",
      "",
      "## Summary",
      "Text.",
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("reports both heading rules in order when a visible review heading violates both", () => {
    const body = [
      "## Summary",
      "## Review rounds",
      "## Verification gate",
      "## Checklist",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R6 line 2[\s\S]*R3 line 2/);
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

  it("passes an unbolded bot summary appended below the footer", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
      footer,
      "",
      "## Summary by Sourcery",
      "",
      "- Bug fix: something changed.",
      "",
      "## Summary by CodeRabbit",
      "",
      "Walkthrough text.",
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("does not charge bot lines below the footer to the unfolded budget", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
      footer,
      "",
      ...Array.from({ length: 200 }, (_, i) => `Bot line ${i}.`),
    ].join("\n");
    const { code, out } = run(body, ["--max-open", "30"]);
    assert.equal(code, 0, out);
  });

  it("ignores an unclosed bot fold below the footer", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
      footer,
      "",
      "<details>",
      "bot text with no summary and no close",
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 0, out);
  });

  it("still fails an authored violation above the footer when bots appended below", () => {
    const body = [
      "## Summary",
      "Text.",
      "## Review rounds",
      "- round one",
      footer,
      "",
      "## Summary by Sourcery",
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /R3 line 3/);
  });

  it("still fails a footer duplicated into the bot territory", () => {
    const body = [
      "## Summary",
      "Text.",
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
      footer,
      "",
      "## Summary by Sourcery",
      "",
      footer,
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /appears 2 times/);
  });

  it("does not start the bot territory at a footer hidden inside a fold", () => {
    const body = [
      "## Summary",
      "Text.",
      "<details>",
      "<summary>Review log</summary>",
      footer,
      "</details>",
      "## Review rounds",
      "- round one",
    ].join("\n");
    const { code, out } = run(body);
    assert.equal(code, 1);
    assert.match(out, /footer line sits inside a fold/);
    assert.match(out, /R3 line 7/);
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
      "",
      "## Verification gate",
      "Head SHA: `abc1234`",
      "",
      "## Checklist",
      "- [x] one",
      "",
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
