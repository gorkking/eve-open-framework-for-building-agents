import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { MEMORY_FACT, MEMORY_PHRASE, SAVE_CONFIRMATION } from "../agent/constants.js";

export default defineEval({
  description: "File memory persists a saved fact and recalls it in a new session.",

  async test(t) {
    const saved = await t.send(
      `Call \`user__save_memory\` exactly once with this exact \`text\` argument: ` +
        `"${MEMORY_FACT}" After the tool succeeds, reply with exactly ${SAVE_CONFIRMATION}.`,
    );
    saved.expectOk();
    saved.calledTool("user__save_memory", {
      count: 1,
      input: { text: MEMORY_FACT },
      status: "completed",
    });
    saved.messageIncludes(SAVE_CONFIRMATION);

    const nextSession = t.newSession();
    const recalled = await nextSession.send(
      "What is the verification phrase in persistent memory? Reply with the phrase only. " +
        "Do not call any tools.",
    );
    recalled.expectOk();
    recalled.usedNoTools();
    recalled.messageIncludes(MEMORY_PHRASE);
    await t.require(recalled.sessionId === saved.sessionId, equals(false));
  },
});
