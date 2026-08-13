import { randomUUID } from "node:crypto";
import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "The worker reads a parent-created file and the parent reads a worker-created file.",
  async test(t) {
    const nonce = `SHARED_SANDBOX_${randomUUID()}`;
    const proof = `WORKER_SAW_${nonce}`;

    await t.send(
      [
        `Run exactly: printf '%s\\n' '${nonce}' > /workspace/parent-nonce.txt`,
        "Call worker and tell it to read /workspace/parent-nonce.txt, verify the exact nonce,",
        `write exactly ${proof} to /workspace/worker-proof.txt, and return exactly ${proof}.`,
        "After worker returns, run exactly: cat /workspace/worker-proof.txt",
        `Reply with exactly ${proof}.`,
      ].join("\n"),
    );

    t.succeeded();
    t.noFailedActions();
    t.calledSubagent("worker", { output: new RegExp(proof), count: 1 });
    t.calledTool("bash", {
      input: { command: "cat /workspace/worker-proof.txt" },
      output: new RegExp(proof),
      count: 1,
    });
    t.messageIncludes(proof);
  },
});
