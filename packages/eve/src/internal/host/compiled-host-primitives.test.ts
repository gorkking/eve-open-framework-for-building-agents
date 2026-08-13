import { describe, expect, it } from "vitest";

describe("compiled host primitive declarations", () => {
  it("stay compatible with the pinned upstream implementations", () => {
    const assertCompatibility = (): void => {
      const croner = {} as Pick<typeof import("croner"), "Cron">;
      const compiledCroner: typeof import("#compiled/croner/index.js") = croner;
      const upstreamH3 = {} as typeof import("h3");
      const app = new upstreamH3.H3({
        onError(error, event) {
          const vendoredError: import("#compiled/h3/index.js").HTTPError = error;
          const vendoredEvent: import("#compiled/h3/index.js").H3Event = event;
          void [vendoredError, vendoredEvent];
          return new Response();
        },
      });
      const h3Handler = upstreamH3.defineWebSocketHandler(
        (event: import("h3").H3Event) => {
          const vendoredEvent: import("#compiled/h3/index.js").H3Event = event;
          void vendoredEvent;
          return {};
        },
        (event) => upstreamH3.handleCors(event, {}),
      );
      app.get("/", h3Handler);
      const node = {} as Pick<typeof import("crossws/server/node"), "serve">;
      const compiledNode: typeof import("#compiled/crossws/node.js") = node;
      const vercel = {} as Pick<typeof import("crossws/adapters/vercel"), "default">;
      const compiledVercel: typeof import("#compiled/crossws/vercel.js") = vercel;
      void [compiledCroner, app, compiledNode, compiledVercel];
    };

    expect(assertCompatibility).toEqual(expect.any(Function));
  });
});
