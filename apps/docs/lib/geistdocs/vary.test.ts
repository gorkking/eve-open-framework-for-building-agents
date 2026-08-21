import { describe, expect, it } from "vitest";
import { appendVaryAccept } from "./vary";

describe("negotiated response Vary header", () => {
  it("preserves framework tokens and adds Accept once", () => {
    const response = new Response(null, {
      headers: { Vary: "rsc, next-router-state-tree" },
    });

    appendVaryAccept(response);
    appendVaryAccept(response);

    expect(response.headers.get("vary")).toBe("rsc, next-router-state-tree, Accept");
  });
});
