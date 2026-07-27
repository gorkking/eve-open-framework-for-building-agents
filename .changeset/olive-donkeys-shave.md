---
"eve": patch
---

Run authored instrumentation before the rest of the server bundle, so OpenTelemetry auto-instrumentations can patch dependencies such as `pg`.

`agent/instrumentation.ts`'s `setup` callback previously ran from a Nitro plugin. Plugin bodies are inlined into the bundled entry, while the entry's dependencies — including externals — are hoisted static imports above them, and ESM evaluates every import before any body code. A driver was therefore already loaded by the time `registerOTel` installed its require hook, so no spans were produced for it. The instrumentation module is now emitted as its own chunk and imported on the entry's first line, ahead of every hoisted import.
