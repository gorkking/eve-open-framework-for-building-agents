import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Implement the task in /workspace/brief.md and write a summary to /workspace/child-result.md.",
  model: "anthropic/claude-sonnet-5",
});
