import { defineEval } from "eve/evals";

/**
 * A marked step selects an explicit reference with context metadata; the next
 * turn's step selects the plain matrix model. Both must complete.
 */
export default defineEval({
  description: "Dynamic model smoke: per-step selections in one session.",
  async test(t) {
    const selected = await t.send(
      '[model: mini] Reply with exactly the text "mini ping" and nothing else.',
    );
    selected.expectOk();
    selected.messageIncludes("mini ping");

    const defaultSelection = await t.send(
      'Reply with exactly the text "default again" and nothing else.',
    );
    defaultSelection.expectOk();
    defaultSelection.messageIncludes("default again");

    t.succeeded();
    t.usedNoTools();
  },
});
