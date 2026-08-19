import { defineChannel, POST } from "#public/definitions/channel.js";

export default defineChannel({
  routes: [POST("/input", async () => new Response("ok"))],
  turnPolicy: "queue",
});
