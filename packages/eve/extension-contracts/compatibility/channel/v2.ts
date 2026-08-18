/**
 * Representative channel authoring example for epoch 2. Retained because
 * epoch 3 only widens `TaskMetadata.kind` from `"subagent"` to
 * `"subagent" | "tool"`, which is additive for producers: an epoch-2
 * consumer that narrows on `kind === "subagent"` still compiles, and no
 * production dispatch path emits `"tool"` yet.
 */

import { defineChannel, POST } from "#public/definitions/channel.js";

export default defineChannel<{ deliveries: number; lastSender: string }>({
  state: { deliveries: 0, lastSender: "" },
  routes: [
    POST("/message", async (request, { from }) => {
      const body = (await request.json()) as {
        message: string;
        threadId?: string;
        userId?: string;
      };
      const sender = body.userId ?? "anonymous";
      await from(`conversation:${body.threadId ?? sender}`).send(body.message, {
        auth: null,
        state: { deliveries: 1, lastSender: sender },
      });
      return Response.json({ accepted: true });
    }),
  ],
});
