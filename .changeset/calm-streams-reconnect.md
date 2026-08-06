---
"eve": patch
---

Client session streams now reconnect open responses that stop delivering bytes, resuming from the durable cursor so buffered terminal events still reach callers.
