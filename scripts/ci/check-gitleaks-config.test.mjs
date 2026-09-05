import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  indexOfOutsideStrings,
  stripTomlComments,
  updaterRulePattern,
} from "./check-gitleaks-config.mjs";

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

describe("indexOfOutsideStrings", () => {
  it("finds markers that sit outside strings", () => {
    assert.equal(indexOfOutsideStrings("a = 1\n[[rules]]\n", "[[rules]]"), 6);
    assert.equal(indexOfOutsideStrings("xyz", "zz"), -1);
  });

  it("skips markers inside basic, literal and multi-line strings", () => {
    assert.equal(
      indexOfOutsideStrings(
        `regex = "x[allowlist]y"\n[allowlist]\n`,
        "[allowlist]",
      ),
      `regex = "x[allowlist]y"\n`.length,
    );
    assert.equal(
      indexOfOutsideStrings(
        `regex = 'x[allowlist]y'\n[allowlist]\n`,
        "[allowlist]",
      ),
      `regex = 'x[allowlist]y'\n`.length,
    );
    assert.equal(
      indexOfOutsideStrings(
        "regex = '''\nx[allowlist]y\n'''\n[allowlist]\n",
        "[allowlist]",
      ),
      "regex = '''\nx[allowlist]y\n'''\n".length,
    );
  });

  it("honours escaped quotes while skipping", () => {
    assert.equal(
      indexOfOutsideStrings(
        `a = "s\\\"[allowlist]\"\n[allowlist]`,
        "[allowlist]",
      ),
      `a = "s\\"[allowlist]"\n`.length,
    );
  });

  it("respects the from offset", () => {
    assert.equal(indexOfOutsideStrings("[a] [a]", "[a]", 2), 4);
  });

  it("returns -1 for an unclosed string instead of matching inside it", () => {
    assert.equal(indexOfOutsideStrings(`a = "[allowlist]`, "[allowlist]"), -1);
  });
});

describe("updaterRulePattern", () => {
  const idLine = `id = "tauri-minisign-updater-private-key"`;

  it("reads the regex from every TOML string form", () => {
    assert.equal(
      updaterRulePattern(`${idLine}\nregex = '''dW50cnVzdGVk'''\n`),
      "dW50cnVzdGVk",
    );
    assert.equal(
      updaterRulePattern(`${idLine}\nregex = 'dW50cnVzdGVk'\n`),
      "dW50cnVzdGVk",
    );
    assert.equal(
      updaterRulePattern(`${idLine}\nregex = "dW50cnVzdGVk"\n`),
      "dW50cnVzdGVk",
    );
    assert.equal(
      updaterRulePattern(`${idLine}\nregex = """dW50cnVzdGVk"""\n`),
      "dW50cnVzdGVk",
    );
  });

  it("skips earlier keys and picks the updater rule, not another rule", () => {
    const toml = `[[rules]]\nid = "some-other-rule"\nregex = 'not-this'\n\n[[rules]]\n${idLine}\ndescription = "x"\nregex = '''dW50cnVzdGVk'''\n`;
    assert.equal(updaterRulePattern(toml), "dW50cnVzdGVk");
  });

  it("returns null when the id or the regex key is missing", () => {
    assert.equal(updaterRulePattern(`regex = 'x'\n`), null);
    assert.equal(updaterRulePattern(`${idLine}\nentropy = 3.5\n`), null);
  });
});
