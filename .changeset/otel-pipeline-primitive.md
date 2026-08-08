---
"eve": patch
---

eve now builds its OpenTelemetry pipeline from a declared `otel()` value with the local trace spool as an ordinary span processor, instead of registering the provider and the spool as one unit. Internal groundwork for authored instrumentation providers; the spans and attributes eve records are unchanged.
