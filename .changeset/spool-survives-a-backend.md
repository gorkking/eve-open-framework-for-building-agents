---
"eve": patch
---

Keep `eve dev`'s local trace spool on when an agent adds a hosted destination
under the experimental provider layout. Authoring any file in
`agent/instrumentation/` used to switch local tracing off, contradicting what
`localTraces()` and `disableInstrumentation()` promise: eve now fills the
`local` slot by default, so a file only changes the spool when it says
something about it.
