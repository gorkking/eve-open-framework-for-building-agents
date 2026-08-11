import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/** A throwing resolver fails the session instead of selecting another model. */
export default defineEval({
  description: "Dynamic model smoke: resolver failures stop the session.",
  async test(t) {
    const failed = await t.send("[model: boom] This turn must fail before model execution.");

    t.check(failed.status, equals("failed"));
    failed.event("session.failed");
  },
});
