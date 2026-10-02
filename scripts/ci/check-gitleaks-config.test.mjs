import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  PREAMBLE_B64,
  hasTopLevelUseDefaultFalse,
  hasUseDefaultFalse,
  indexOfOutsideStrings,
  stripTomlComments,
  tomlTableBody,
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

describe("hasTopLevelUseDefaultFalse", () => {
  it("detects the real top-level assignment (spaced and compact)", () => {
    assert.equal(hasTopLevelUseDefaultFalse("useDefault = false\n"), true);
    assert.equal(hasTopLevelUseDefaultFalse("useDefault=false\n"), true);
  });

  it("ignores prose inside a multi-line description string", () => {
    const topLevel = [
      'description = """',
      "Do not set useDefault = false here;",
      "this is documentation, not TOML.",
      '"""',
      "",
    ].join("\n");
    assert.equal(hasTopLevelUseDefaultFalse(topLevel), false);
  });

  it("ignores a single-line string value containing the text", () => {
    assert.equal(
      hasTopLevelUseDefaultFalse('description = "useDefault = false"\n'),
      false,
    );
    assert.equal(
      hasTopLevelUseDefaultFalse("description = 'useDefault = false'\n"),
      false,
    );
  });

  it("does not match a longer key or a different boolean", () => {
    assert.equal(hasTopLevelUseDefaultFalse("useDefaultX = false\n"), false);
    assert.equal(hasTopLevelUseDefaultFalse("useDefault = true\n"), false);
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

  it("accepts indented and single-quoted id lines", () => {
    assert.equal(
      updaterRulePattern(`  ${idLine}\n  regex = 'dW50cnVzdGVk'\n`),
      "dW50cnVzdGVk",
    );
    assert.equal(
      updaterRulePattern(
        `${idLine.replaceAll('"', "'")}\nregex = 'dW50cnVzdGVk'\n`,
      ),
      "dW50cnVzdGVk",
    );
  });

  it("returns null when the id or the regex key is missing", () => {
    assert.equal(updaterRulePattern(`regex = 'x'\n`), null);
    assert.equal(updaterRulePattern(`${idLine}\nentropy = 3.5\n`), null);
  });

  it("never attributes a later rule's regex to the updater rule", () => {
    const toml = `[[rules]]\n${idLine}\nentropy = 3.5\n\n[[rules]]\nid = "another-rule"\nregex = 'dW50cnVzdGVk'\n`;
    assert.equal(updaterRulePattern(toml), null);
  });

  // A description is free text, so it can contain the text `regex =` on its own
  // line inside a multi-line string. Searching raw text then finds that one
  // first and reads the wrong value, which is the value this function exists to
  // compare against the shipped preamble.
  it("ignores a regex key that only appears inside a multi-line string", () => {
    const toml = [
      'id = "tauri-minisign-updater-private-key"',
      'description = """',
      "Detects the updater key.",
      "",
      "regex = 'not-the-rule'",
      '"""',
      "regex = 'dW50cnVzdGVk'",
    ].join("\n");
    assert.equal(updaterRulePattern(toml), "dW50cnVzdGVk");
  });

  it("ignores a regex key that only appears inside a single-line string", () => {
    const toml = [
      'id = "tauri-minisign-updater-private-key"',
      "description = 'use regex = not-the-rule here'",
      'keywords = ["regex = also-not-the-rule"]',
      "regex = 'dW50cnVzdGVk'",
    ].join("\n");
    assert.equal(updaterRulePattern(toml), "dW50cnVzdGVk");
  });

  // Both of the next two are the same defect seen from each side: the id was
  // found by trimming lines, so a quoted id line inside a description looked
  // like the rule, and the search for `regex` then began mid-description with
  // the description's own string still open.
  it("ignores an id line that only appears inside a description", () => {
    const toml = [
      "[[rules]]",
      'description = """',
      "The rule below is the one CI looks for:",
      'id = "tauri-minisign-updater-private-key"',
      `regex = '${PREAMBLE_B64}'`,
      '"""',
      "entropy = 3.5",
    ].join("\n");
    assert.equal(
      updaterRulePattern(toml),
      null,
      "prose must not supply the rule's detector",
    );
  });

  it("still finds the detector when a description quotes the rule's own id", () => {
    const toml = [
      "[[rules]]",
      'description = """',
      "The rule below is the one CI looks for:",
      'id = "tauri-minisign-updater-private-key"',
      '"""',
      'id = "tauri-minisign-updater-private-key"',
      `regex = '${PREAMBLE_B64}'`,
    ].join("\n");
    assert.equal(updaterRulePattern(toml), PREAMBLE_B64);
  });
});

describe("hasUseDefaultFalse quoted keys", () => {
  it("detects quoted keys", () => {
    assert.equal(hasUseDefaultFalse('"useDefault" = false\n'), true);
    assert.equal(hasUseDefaultFalse("'useDefault' = false\n"), true);
    assert.equal(hasUseDefaultFalse('"useDefault"=false\n'), true);
    assert.equal(hasUseDefaultFalse('"useDefault" = true\n'), false);
  });
});

describe("tomlTableBody [extend]", () => {
  it("reads useDefault from [extend] and ignores a dotted sibling", () => {
    const withExtend = [
      "[extend]",
      "useDefault = false",
      "[allowlist]",
      'description = "x"',
      "",
    ].join("\n");
    assert.equal(
      hasUseDefaultFalse(tomlTableBody(withExtend, "[extend]")),
      true,
    );

    const quoted = ["[extend]", '"useDefault" = false', ""].join("\n");
    assert.equal(hasUseDefaultFalse(tomlTableBody(quoted, "[extend]")), true);

    const dotted = ["[extend.foo]", "useDefault = false", ""].join("\n");
    assert.equal(tomlTableBody(dotted, "[extend]"), "");
    assert.equal(hasUseDefaultFalse(tomlTableBody(dotted, "[extend]")), false);
  });
});

describe("CLI requires explicit built-in rule extension", () => {
  // The rule block is a column so a case can replace it: the point of the last
  // case is a config whose only `regex =` line is inside a description, which
  // the shared trailing rule would otherwise satisfy.
  const realRule = `[[rules]]\nid = "tauri-minisign-updater-private-key"\nregex = '${PREAMBLE_B64}'\n`;
  for (const [name, extension, status, rules = realRule] of [
    ["missing extension", "", 1],
    ["ignored top-level option", "useDefault = true\n", 1],
    [
      "prose instead of assignment",
      '[extend]\ndescription = "useDefault = true"\n',
      1,
    ],
    [
      "indented nested table",
      "[extend]\n  [extend.other]\nuseDefault = true\n",
      1,
    ],
    ["explicit extension", "[extend]\nuseDefault = true\n", 0],
    ["quoted option", '[extend]\n"useDefault" = true\n', 0],
    [
      "a detector written only inside a description",
      "[extend]\nuseDefault = true\n",
      1,
      `[[rules]]\ndescription = """\nid = "tauri-minisign-updater-private-key"\nregex = '${PREAMBLE_B64}'\n"""\nentropy = 3.5\n`,
    ],
  ]) {
    it(name, (t) => {
      const root = mkdtempSync(join(tmpdir(), "gitleaks-config-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const dir = join(root, "scripts", "ci");
      mkdirSync(dir, { recursive: true });
      const script = join(dir, "check-gitleaks-config.mjs");
      copyFileSync(
        new URL("./check-gitleaks-config.mjs", import.meta.url),
        script,
      );
      writeFileSync(
        join(root, "gitleaks.toml"),
        `${extension}\n[allowlist]\ndescription = "test"\n${rules}`,
      );
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
      });
      assert.equal(result.status, status, result.stdout + result.stderr);
    });
  }
});
