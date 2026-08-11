import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/** Dynamic selections resolve omitted context-window metadata through the runtime catalog. */
export default defineEval({
  description: "Dynamic model smoke: runtime catalog metadata resolution.",
  async test(t) {
    const known = await t.send(
      '[model: catalog] Reply with exactly the text "catalog ping" and nothing else.',
    );
    known.expectOk();
    known.messageIncludes("catalog ping");

    const unknown = await t.send(
      "[model: catalog-unknown] This turn must fail before model execution.",
    );
    t.check(unknown.status, equals("failed"));
    unknown.eventsSatisfy("reports missing model catalog metadata", (events) =>
      events.some(
        (event) =>
          event.type === "turn.failed" &&
          event.data.message.includes("does not have known AI Gateway context window metadata"),
      ),
    );
  },
});
