import { describe, expect, expectTypeOf, it } from "vitest";

import {
  defineEmbeddedAgent,
  type DefinedEmbeddedAgent,
  type EmbeddedAgentDefinition,
  type EmbeddedAgentResources,
} from "./definition.js";

describe("defineEmbeddedAgent", () => {
  it("rejects obsolete and unknown authored fields at compile time", () => {
    const agentWithUnknownField = {
      model: "openai/gpt-5.4-mini",
      unknown: true,
    };
    void defineEmbeddedAgent({
      // @ts-expect-error Embedded agent config uses the exact AgentDefinition shape.
      agent: agentWithUnknownField,
      resources: { instructions: "Classify." },
    });

    const resourcesWithUnknownField = {
      instructions: "Classify.",
      unknown: true,
    };
    expect(() =>
      defineEmbeddedAgent({
        agent: { model: "openai/gpt-5.4-mini" },
        // @ts-expect-error Embedded resources reject unrecognized fields.
        resources: resourcesWithUnknownField,
      }),
    ).toThrow('resources field "unknown"');

    const obsoleteFlatDefinition = {
      instructions: "Classify.",
      model: "openai/gpt-5.4-mini",
    };
    expect(() => {
      // @ts-expect-error The obsolete flat embedded definition is not supported.
      defineEmbeddedAgent(obsoleteFlatDefinition);
    }).toThrow('definition field "instructions"');
  });

  it("returns a copied agent definition with non-enumerable embedded metadata", () => {
    const agent = { model: "openai/gpt-5.4-mini" } as const;
    const definition = defineEmbeddedAgent({
      agent,
      resources: { instructions: "Classify the ticket." },
    });

    expect(definition).toEqual(agent);
    expect(definition).not.toBe(agent);
    expect(Object.keys(definition)).toEqual(["model"]);
    expect(Object.getOwnPropertySymbols(definition)).toHaveLength(2);
    expect(Object.hasOwn(agent, Symbol.for("eve.experimental.embedded-agent"))).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(
        definition,
        Symbol.for("eve.experimental.embedded-agent.resources"),
      ),
    ).toMatchObject({ enumerable: false, value: { instructions: "Classify the ticket." } });
    expectTypeOf(definition).toMatchTypeOf<
      DefinedEmbeddedAgent<{ readonly model: "openai/gpt-5.4-mini" }>
    >();
  });

  it.each([
    [null, "object definition"],
    [{ resources: { instructions: "Classify." } }, 'object "agent" field'],
    [{ agent: [], resources: { instructions: "Classify." } }, 'object "agent" field'],
    [{ agent: {} }, 'object "resources" field'],
    [{ agent: {}, resources: [] }, 'object "resources" field'],
    [{ agent: {}, resources: { instructions: 42 } }, 'string "resources.instructions" field'],
  ])("rejects malformed definitions %#", (definition, message) => {
    expect(() => defineEmbeddedAgent(definition as EmbeddedAgentDefinition)).toThrow(message);
  });

  it("rejects unknown authored fields at runtime", () => {
    const definition: EmbeddedAgentDefinition = {
      agent: { model: "openai/gpt-5.4-mini" },
      resources: { instructions: "Classify." },
    };
    Object.defineProperty(definition, "unknown", { enumerable: true, value: true });
    expect(() => defineEmbeddedAgent(definition)).toThrow('definition field "unknown"');

    const resources: EmbeddedAgentResources = { instructions: "Classify." };
    Object.defineProperty(resources, "unknown", { enumerable: true, value: true });
    expect(() =>
      defineEmbeddedAgent({ agent: { model: "openai/gpt-5.4-mini" }, resources }),
    ).toThrow('resources field "unknown"');
  });

  it.each(["channels", "schedules", "sandbox", "tools"] as const)(
    'rejects the unsupported resource "%s" when it is supplied',
    (resource) => {
      const resources: EmbeddedAgentResources = { instructions: "Classify the ticket." };
      Object.defineProperty(resources, resource, { enumerable: true, value: undefined });

      expect(() =>
        defineEmbeddedAgent({
          agent: { model: "openai/gpt-5.4-mini" },
          resources,
        }),
      ).toThrow(
        `Embedded agent resource "${resource}" is not supported by this experimental prototype.`,
      );
    },
  );
});
