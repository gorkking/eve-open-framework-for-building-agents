import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

const LIFECYCLE_CONTRACT = "packages/eve/src/harness/instrumentation-lifecycle.ts";

/**
 * @param {string} posix
 * @param {string} source
 * @param {{ rule: number; file: string; line?: number; message: string }[]} violations
 */
export function checkRule37(posix, source, violations) {
  if (posix !== LIFECYCLE_CONTRACT) return;

  const sourceFile = ts.createSourceFile(
    posix,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node) => {
    const specifier = importSpecifier(node);
    if (specifier !== undefined && (specifier.text === "ai" || specifier.text.startsWith("ai/"))) {
      violations.push({
        rule: 37,
        file: posix,
        line: sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile)).line + 1,
        message: `imports from "ai". Lifecycle event payloads are eve's own shape, so an AI SDK type reaching them makes an SDK upgrade a breaking change for every provider. Add an eve type here and map to it in ai-sdk-hook-bridge.ts.`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function importSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0];
  }
  return undefined;
}
