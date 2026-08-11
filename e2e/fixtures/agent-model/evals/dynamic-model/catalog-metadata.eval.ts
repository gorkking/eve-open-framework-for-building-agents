import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/** Dynamic selections resolve and reuse omitted context-window metadata at runtime. */
export default defineEval({
  description: "Dynamic model smoke: runtime catalog metadata resolution and reuse.",
  async test(t) {
    const known = await t.send(
      '[model: catalog] Reply with exactly the text "catalog ping" and nothing else.',
    );
    known.expectOk();
    known.messageIncludes("catalog ping");

    const cached = await t.send(
      '[model: catalog] Reply with exactly the text "cached ping" and nothing else.',
    );
    cached.expectOk();
    cached.messageIncludes("cached ping");

    const unknown = await t.send(
      "[model: catalog-unknown] This turn must fail before model execution.",
    );
    t.check(unknown.status, equals("failed"));
    unknown.eventsSatisfy("reports missing model catalog metadata", (events) =>
      events.some(
        (event) =>
          event.type === "session.failed" &&
          event.data.message.includes("does not have known AI Gateway context window metadata"),
      ),
    );
  },
});
