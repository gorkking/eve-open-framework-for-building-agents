import { e2eAgentConfig, type E2EModel } from "@eve-e2e/config";
import { defineAgent, defineDynamic, type DynamicResolveContext } from "eve";

const { experimental, model: configuredModel, modelContextWindowTokens } = e2eAgentConfig();
const model = configuredModel as E2EModel;

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
  experimental,
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

        if (text.includes("[model: catalog-unknown]")) {
          return "unknown/eve-dynamic-model";
        }

        if (text.includes("[model: catalog]")) {
          return typeof model === "string" ? model : "openai/gpt-5.4";
        }

        if (text.includes("[model: mini]")) {
          return {
            model,
            modelContextWindowTokens: 128_000,
          };
        }

        return modelContextWindowTokens === undefined ? model : { model, modelContextWindowTokens };
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
