---
"eve": patch
---

Let an instrumentation provider declare how much of each event it wants. Under
the experimental provider layout, `capture: "content"` opts a provider into the
prompt, the response, and tool payloads; the default `"metadata"` leaves it
structure, usage, and timing. Content is now built only when something asked for
it, so an agent whose providers and destinations all decline never serializes a
prompt at all.
