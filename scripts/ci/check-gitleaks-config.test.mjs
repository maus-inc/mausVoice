import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTomlComments } from "./check-gitleaks-config.mjs";

describe("stripTomlComments", () => {
  it("drops full-line and trailing comments", () => {
    assert.equal(
      stripTomlComments("# useDefault = false\nuseDefault = true # note\n"),
      "\nuseDefault = true \n",
    );
  });

  it("keeps # inside basic and literal strings", () => {
    assert.equal(
      stripTomlComments(`a = "x # y" # c\nb = 'p # q' # d\n`),
      `a = "x # y" \nb = 'p # q' \n`,
    );
  });

  it("honours escaped quotes in basic strings", () => {
    assert.equal(
      stripTomlComments(`a = "say \\"#\\" here" # gone\n`),
      `a = "say \\"#\\" here" \n`,
    );
  });

  it("keeps # across multi-line triple-quoted strings", () => {
    const toml = `regex = '''\nfoo # not a comment\n'''  # comment\nx = """\n# also content\n""" # gone\n`;
    assert.equal(
      stripTomlComments(toml),
      `regex = '''\nfoo # not a comment\n'''  \nx = """\n# also content\n""" \n`,
    );
  });

  it("does not treat a quote inside a comment as a string opener", () => {
    assert.equal(
      stripTomlComments(`a = 1 # it's fine\nb = 2 # useDefault = false\n`),
      `a = 1 \nb = 2 \n`,
    );
  });
});
