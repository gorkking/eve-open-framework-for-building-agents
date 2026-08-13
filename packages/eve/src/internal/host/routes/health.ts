import type { H3Event } from "h3";
import { workflowEntryReference } from "#execution/workflow-runtime.js";

/**
 * eve host route for the public health endpoint.
 *
 * The health endpoint is intentionally always-public so platform load
 * balancers and uptime monitors can probe it without credentials.
 * Channels that need authenticated health probes should author their own
 * channel file with the verifier helpers from
 * `eve/channels/auth`.
 */
export default async (_event: H3Event): Promise<Response> => {
  return Response.json({
    ok: true,
    status: "ready",
    workflowId: workflowEntryReference.workflowId,
  });
};
