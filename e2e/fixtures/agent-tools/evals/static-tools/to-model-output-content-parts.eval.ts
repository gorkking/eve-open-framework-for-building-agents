import { defineEval } from "eve/evals";

const TOOL_NAME = "render-stripes";

// The pixels reach the model exclusively through `toModelOutput` content
// parts. Unit coverage asserts their exact model-facing shape; this hosted
// smoke test only verifies that the tool-result turn completes.
export default defineEval({
  description: "Static tools smoke: toModelOutput content parts complete a model turn.",
  async test(t) {
    await t.send(`Call \`${TOOL_NAME}\` exactly once, then confirm that rendering is complete.`);

    t.succeeded();
    t.noFailedActions();
    t.calledTool(TOOL_NAME, { count: 1, output: isRenderStripesOutput });
  },
});

function isRenderStripesOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const output = value as { readonly colors?: unknown; readonly imageBase64?: unknown };
  return (
    Array.isArray(output.colors) &&
    output.colors.length > 0 &&
    output.colors.every((color) => typeof color === "string") &&
    typeof output.imageBase64 === "string" &&
    output.imageBase64.startsWith("iVBOR") // PNG magic bytes, base64-encoded
  );
}
