---
"eve": patch
---

Park durable sessions when `turn.started` or first-attempt `step.started` event handlers throw, so follow-up turns remain available after an admission failure.
