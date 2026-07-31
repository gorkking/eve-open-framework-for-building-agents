---
title: "Prompt Injection Mitigation"
description: "Protect agents that handle untrusted content by limiting access and controlling tool results."
---

Prompt injection happens when a model follows instructions embedded in messages, files, or tool results. A detector or a rule in your prompt cannot remove that risk. Limit what the model can access, control the results it receives, and keep sensitive authorization in code.

Model providers may apply their own safeguards. Those safeguards vary by model and provider, and they do not replace application controls.

## Identify untrusted inputs

Treat every string from outside your application as untrusted. This includes:

- User and channel messages, attachments, filenames, and metadata
- Web pages, search results, sandbox files, and command output
- Tool, Model Context Protocol (MCP), and OpenAPI results
- Images, optical character recognition (OCR) text, audio transcripts, and documents
- Subagent or model summaries derived from untrusted content

Remote tool descriptions and OpenAPI documents also enter model context. Connect only to services and specifications you trust.

## Limit model capabilities

Screening will miss some injections. Give the model only the access it needs:

- Disable unused built-in tools, especially `bash`, `write_file`, `web_fetch`, `web_search`, and `agent`
- Allow-list MCP tools and OpenAPI operations
- Give service credentials and network access only the permissions the tool needs
- Derive tenant, user, and resource identifiers in application code
- Enforce authorization inside every sensitive tool
- Require [approval](/docs/human-in-the-loop) for consequential actions

Approval limits consequences, but it does not authorize a request or detect injection. Show approvers the exact action and target. Validate both again in `execute`.

Use a [declared subagent](../subagents#the-isolation-boundary) when hostile content needs a narrower tool set. Disable unwanted framework defaults in that subagent's `tools/` directory. The built-in `agent` tool is not an isolation boundary because its child inherits the root agent's tools and connections.

## Control what the model sees from tools

Use `toModelOutput` to control what a custom tool returns to the model. Your application can keep the complete result for its own event handlers while the model receives a smaller result.

For example, replace `web_fetch` with a custom tool that reads an approved help center. It runs only when the model calls it, not for incoming channel messages. Keep source selection and authorization in `execute`.

Add this mapping to a custom tool whose `execute` result has a string `body` field:

```ts
async toModelOutput(article) {
  // Use size-limited checks or a detection service.
  // Make `detectPromptInjection` return `failed: true` on errors or timeouts.
  const detection = await detectPromptInjection(article.body);
  if (detection.detected || detection.failed) {
    return toolOutput.json({ reason: "untrusted_content", status: "withheld" });
  }
  return toolOutput.json({ status: "ok" });
},
```

Do not send matched text or detector details back to the model. The full `execute` result stays in durable `action.result` events. Sanitize inside `execute` when you must keep raw content out of the event stream.

Direct MCP and OpenAPI connections cannot use `toModelOutput`. Filter their results in the upstream service or replace the connection with a custom tool. Override or disable framework tools that return untrusted content. Replace provider-managed `web_search` before you can filter its results.

## Screen messages and isolate untrusted code

Screen messages in a channel's pre-dispatch callback before eve starts a session. For custom channels and application routes, screen the message before calling the eve receive or session API.

For example, add this callback to an existing Slack channel configuration. It uses the same detector as the tool example:

```ts
onAppMention: async (ctx, message) => {
  const detection = await detectPromptInjection(message.text);
  if (detection.detected || detection.failed) {
    await ctx.thread.post("I can't process this request.");
    return null;
  }
  return { auth: null };
},
```

Keep rejection messages generic. Detailed detector feedback helps attackers tune later attempts. Decide what your agent does when detection errors, times out, or cannot process the content.

Run untrusted code in the [sandbox](../sandbox). Set `networkPolicy` to `"deny-all"` or an explicit allow-list, and keep secrets out of the sandbox:

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  async onSession({ use }) {
    await use({ networkPolicy: "deny-all" });
  },
});
```

Sandboxing limits code execution and egress; it does not stop a model from following hostile text.

## Test the protections

Test your detector and tool-output mapping directly. Then use [evals](../evals) to run the assembled agent against:

- Instruction overrides in messages, documents, tool results, filenames, and metadata
- Encoded, fragmented, Unicode, invisible-character, image, and OCR variants
- Detector errors, timeouts, and oversized input
- Benign documents that discuss prompt injection

Test what the agent did, not its exact wording. Verify that identifiers come from code, unavailable tools are not called, and sensitive actions require authorization and approval.

## What to read next

- [Tools](../tools): define, restrict, and control tool output
- [Security model](../concepts/security-model): review eve's runtime and sandbox boundaries
- [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [NCSC: Prompt injection is not SQL injection](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection)
