import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverTaskInputResponsesStep } from "#execution/tasks/child/steps.js";

describe("deliverTaskInputResponsesStep", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts only the answered requests to a remote child's response capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverTaskInputResponsesStep({
        answer: {
          childContinuationToken: "remote-child-token",
          childResponseUrl: "https://remote.example/eve/v1/task-input/capability",
          inputResponses: [
            { requestId: "request-1", text: "first answer" },
            { optionId: "approve", requestId: "request-2" },
          ],
          kind: "input-response",
          taskId: "task-1",
        },
        requestIds: ["request-2"],
      }),
    ).resolves.toBe("delivered");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example/eve/v1/task-input/capability", {
      body: JSON.stringify({
        inputResponses: [{ optionId: "approve", requestId: "request-2" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
    });
  });
});
