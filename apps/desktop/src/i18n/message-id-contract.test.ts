import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "./locales/en.json";

const literalId = (node: ts.Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isJsxExpression(node)) return literalId(node.expression);
  return undefined;
};

/** Direct literal IDs are preserved by the build, not replaced by default-message IDs. */
const explicitMessageIds = (source: ts.SourceFile): string[] => {
  const ids: string[] = [];
  const record = (node: ts.Node | undefined) => {
    const id = literalId(node);
    if (id !== undefined) ids.push(id);
  };
  const inspectJsx = (node: ts.JsxOpeningLikeElement): void => {
    if (node.tagName.getText(source) !== "FormattedMessage") return;
    for (const attribute of node.attributes.properties) {
      if (
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(source) === "id"
      )
        record(attribute.initializer);
    }
  };
  const inspectCall = (node: ts.CallExpression): void => {
    const descriptor = node.arguments[0];
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "formatMessage" ||
      !descriptor ||
      !ts.isObjectLiteralExpression(descriptor)
    )
      return;
    for (const property of descriptor.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        property.name.getText(source) === "id"
      )
        record(property.initializer);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      inspectJsx(node);
    else if (ts.isCallExpression(node)) inspectCall(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ids;
};

function* productionSources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* productionSources(path);
    else if (/\.tsx?$/.test(path) && !path.includes(".test.")) yield path;
  }
}

const parse = (path: string, text: string) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

describe("literal Intl message IDs", () => {
  it("checks Intl descriptors without treating DOM IDs as translation keys", () => {
    const source = parse(
      "fixture.tsx",
      `
      <div id="not-a-message"><FormattedMessage id="first" defaultMessage="First" /></div>;
      <FormattedMessage id={"second"} defaultMessage="Second" />;
      intl.formatMessage({ id: "third", defaultMessage: "Third" });
      other.method({ id: "not-a-message" });
    `,
    );
    expect(explicitMessageIds(source)).toEqual(["first", "second", "third"]);
  });
  it("has a catalog entry for every direct literal Intl ID in production sources", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const missing: Array<{ path: string; id: string }> = [];
    for (const path of productionSources(root)) {
      for (const id of explicitMessageIds(
        parse(path, readFileSync(path, "utf8")),
      )) {
        if (!Object.hasOwn(en, id))
          missing.push({ path: relative(root, path), id });
      }
    }
    expect(missing).toEqual([]);
  });
});
