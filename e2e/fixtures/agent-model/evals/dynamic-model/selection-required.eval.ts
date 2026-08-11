import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/** An invalid empty selection fails the session before eve calls a model. */
export default defineEval({
  description: "Dynamic model smoke: every matching resolver must select a model.",
  async test(t) {
    const failed = await t.send("[model: missing] This turn must fail before model execution.");

    t.check(failed.status, equals("failed"));
    failed.event("session.failed");
  },
});
