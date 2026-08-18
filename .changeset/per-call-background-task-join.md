---
"eve": patch
---

Under `experimental.tasks`, subagent calls now run in the foreground by default and return the subagent's result; pass `background: true` on a call to launch it as a background task and receive a `{taskId, status}` receipt instead. A new `task_join` tool lets the agent wait for a background task to finish or require input, settling immediately when it already has.
