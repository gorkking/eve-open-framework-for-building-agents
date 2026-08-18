import { localDev, none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// This example accepts anonymous traffic so the demo is clickable without
// signing in. Swap `none()` for a real provider (Auth.js, Clerk,
// `vercelOidc()`, ...) before exposing the agent publicly.
export default eveChannel({
  auth: [localDev(), none()],
});
