import { defineEval } from "eve/evals";

/** Runtime identity does not invent a model id before the resolver runs. */
export default defineEval({
  description: "Dynamic model smoke: runtime identity omits unresolved model ids.",
  async test(t) {
    await t.send('Reply with exactly the text "dynamic ping" and nothing else.');

    t.succeeded();
    t.messageIncludes("dynamic ping");
    t.usedNoTools();
    t.eventsSatisfy("runtime identity omits an unresolved model id", (events) =>
      events.some(
        (event) =>
          event.type === "session.started" &&
          event.data.runtime !== undefined &&
          !Object.hasOwn(event.data.runtime, "modelId"),
      ),
    );
  },
});
