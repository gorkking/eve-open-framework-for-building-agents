---
"eve": patch
---

eve now assembles its local OpenTelemetry runtime from declarative singleton settings and ordered destinations. The local trace spool is an ordinary span processor, and tracer-provider ownership, flushing, and shutdown are managed centrally without changing recorded spans.
