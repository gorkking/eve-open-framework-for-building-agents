import { defineEval } from "eve/evals";

/** The resolver always selects a model, and runtime identity stays model-agnostic. */
export default defineEval({
  description: "Dynamic model smoke: runtime identity reports dynamic selection.",
  async test(t) {
    await t.send('Reply with exactly the text "dynamic ping" and nothing else.');

    t.succeeded();
    t.messageIncludes("dynamic ping");
    t.usedNoTools();
    t.eventsSatisfy("runtime identity reports a dynamic model", (events) =>
      events.some(
        (event) => event.type === "session.started" && event.data.runtime?.modelId === "dynamic",
      ),
    );
  },
});
