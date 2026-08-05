import {
  findProperty,
  type DynamicToolAstNode as AstNode,
  walkNode,
} from "#internal/workflow-bundle/dynamic-tool-ast-references.js";

/** One schema expression and its exact authored source. */
export interface SchemaExpressionInfo {
  readonly node: AstNode;
  readonly source: string;
}

/** Reads a direct schema property from one `defineTool` object argument. */
export function findSchemaExpression(
  source: string,
  toolArg: AstNode,
  propertyName: "inputSchema" | "outputSchema",
): SchemaExpressionInfo | undefined {
  const property = findProperty(toolArg, propertyName);
  const value = property?.value;
  if (
    value === null ||
    typeof value !== "object" ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return undefined;
  }
  const node = value as AstNode;
  if (node.start === undefined || node.end === undefined) {
    return undefined;
  }
  return {
    node,
    source: source.slice(node.start, node.end),
  };
}

/** Returns whether a schema expression can be safely rebuilt at module scope. */
export function canReplaySchemaExpression(
  schema: SchemaExpressionInfo | undefined,
  candidateVars: readonly string[],
): boolean {
  if (schema === undefined) return false;
  if (
    schema.node.type === "Identifier" &&
    schema.node.name !== undefined &&
    candidateVars.includes(schema.node.name)
  ) {
    return false;
  }

  let hasUnsupportedSyntax = false;
  walkNode(schema.node, (node) => {
    if (
      node.type === "AwaitExpression" ||
      node.type === "YieldExpression" ||
      node.type === "ThisExpression"
    ) {
      hasUnsupportedSyntax = true;
      return false;
    }
    return true;
  });
  return !hasUnsupportedSyntax;
}

/** Emits the assignment that attaches one schema factory to a step function. */
export function buildSchemaFactoryRegistration(
  hoistedName: string,
  propertyName: "__eveInputSchemaFactory" | "__eveOutputSchemaFactory",
  schemaSource: string,
  capturedVars: readonly string[],
): string {
  const destructure =
    capturedVars.length === 0 ? "" : `const { ${capturedVars.join(", ")} } = __vars; `;
  return `${hoistedName}.${propertyName} = (__vars) => { ${destructure}return ${schemaSource}; };`;
}
