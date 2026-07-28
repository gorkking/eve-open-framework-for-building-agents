# @vercel/eve-photon

First-class Photon iMessage channel for [eve](https://eve.dev).

```ts
import { connectPhotonCredentials } from "@vercel/connect/eve";
import { photonChannel } from "@vercel/eve-photon";

export default photonChannel({
  credentials: connectPhotonCredentials(process.env.PHOTON_CONNECTOR_ID!),
});
```
