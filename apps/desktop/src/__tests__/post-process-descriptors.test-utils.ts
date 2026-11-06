import ts from "typescript";

const isStaticMessage = (node: ts.Expression): boolean => {
  if (!ts.isObjectLiteralExpression(node)) return false;
  if (
    node.properties.some(
      (property) =>
        !ts.isPropertyAssignment(property) ||
        ts.isComputedPropertyName(property.name),
    )
  )
    return false;
  const defaults = node.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "defaultMessage",
  );
  if (defaults.length !== 1) return false;
  const value = defaults[0].initializer;
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
};

const isDefineMessage = (node: ts.Expression | undefined): boolean =>
  !!node &&
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "defineMessage" &&
  node.arguments.length === 1 &&
  isStaticMessage(node.arguments[0]);

const categoryDescriptor = (
  property: ts.ObjectLiteralElementLike,
): string | null => {
  if (!ts.isPropertyAssignment(property)) return null;
  const name = property.name;
  if (
    !ts.isComputedPropertyName(name) ||
    !ts.isPropertyAccessExpression(name.expression)
  )
    return null;
  const owner = name.expression.expression;
  if (!ts.isIdentifier(owner) || owner.text !== "POST_PROCESS_ERROR_CATEGORY")
    return null;
  return ts.isIdentifier(property.initializer)
    ? property.initializer.text
    : null;
};

type Context = { descriptors: Set<string>; errors: string[] };

function importsDefineMessage(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react-intl"
    )
      return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          element.name.text === "defineMessage" &&
          !element.propertyName &&
          !element.isTypeOnly,
      )
    );
  });
}

function checkDescriptor(
  context: Context,
  name: string,
  identifier: string,
): void {
  if (!context.descriptors.has(identifier)) {
    context.errors.push(
      `${name}: descriptor ${identifier} is not declared by defineMessage`,
    );
  }
}

function checkReason(
  context: Context,
  name: string,
  initializer?: ts.Expression,
): void {
  if (initializer && ts.isIdentifier(initializer))
    checkDescriptor(context, name, initializer.text);
  else if (!isDefineMessage(initializer))
    context.errors.push(`${name}: expected a declared descriptor`);
}

function checkRecord(
  context: Context,
  name: string,
  initializer?: ts.Expression,
): void {
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    context.errors.push(`${name}: expected an object literal`);
    return;
  }
  for (const property of initializer.properties) {
    const identifier = categoryDescriptor(property);
    if (identifier) checkDescriptor(context, name, identifier);
    else context.errors.push(`${name}: expected a category-keyed descriptor`);
  }
}

/** Fail closed if a declared post-processing reason cannot be tied to FormatJS. */
export function inspectPostProcessDescriptors(text: string): {
  records: number;
  errors: string[];
} {
  const source = ts.createSourceFile(
    "post-process-error-category.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations]
      : [],
  );
  const descriptors = new Set(
    declarations
      .filter(
        (node) =>
          ts.isIdentifier(node.name) && isDefineMessage(node.initializer),
      )
      .map((node) => (node.name as ts.Identifier).text),
  );
  const context: Context = { descriptors, errors: [] };
  if (!importsDefineMessage(source))
    context.errors.push("defineMessage must be imported from react-intl");
  let records = 0;
  for (const declaration of declarations) {
    if (!declaration.type || !ts.isIdentifier(declaration.name)) continue;
    const type = declaration.type.getText(source).replace(/\s+/g, "");
    if (type === "PostProcessErrorReason") {
      checkReason(context, declaration.name.text, declaration.initializer);
    } else if (type === "Readonly<Record<string,PostProcessErrorReason>>") {
      records++;
      checkRecord(context, declaration.name.text, declaration.initializer);
    }
  }
  return { records, errors: context.errors };
}
