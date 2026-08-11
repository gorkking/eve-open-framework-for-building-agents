import { e2eAgentConfig, e2eModel, type E2EModel } from "@eve-e2e/config";
import { defineAgent, defineDynamic, type DynamicResolveContext } from "eve";

const model = e2eModel();

type DynamicModelSelection =
  | E2EModel
  | {
      readonly model: E2EModel;
      readonly modelContextWindowTokens: number;
    };

/**
 * Dynamic-model e2e fixture. Resolves at `step.started` so the world suites
 * can select their deterministic provider object directly.
 */
export default defineAgent({
  // Harness config wires the workflow world; the dynamic definition below
  // overrides the harness model.
  ...e2eAgentConfig(),
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx): DynamicModelSelection => {
        const text = lastUserText(ctx.messages);

        if (text.includes("[model: boom]")) {
          throw new Error("dynamic model resolver failed");
        }

        if (text.includes("[model: missing]")) {
          return null as never;
        }

        if (text.includes("[model: mini]")) {
          return {
            model,
            modelContextWindowTokens: 128_000,
          };
        }

        return model;
      },
    },
  }),
});

function lastUserText(messages: DynamicResolveContext["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
  }
  return "";
}
