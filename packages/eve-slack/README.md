# @vercel/eve-slack

First-class Slack channel for [eve](https://eve.dev).

```ts
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "@vercel/eve-slack";

export default slackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR_ID!),
});
```
