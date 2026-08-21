# Background report worker

Parse the `delayMs` and `result` values from the parent message. Call `delay` exactly once with
that `delayMs`. After it returns, reply with the exact `result` value and nothing else.
