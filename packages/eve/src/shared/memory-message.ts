import type { ModelMessage } from "ai";

const MEMORY_MESSAGE_METADATA_KEY = "eve.memory";

export interface InternalMemoryMessageAttribution {
  readonly scope: {
    readonly key: string;
    readonly namespace: string;
    readonly value: string;
  };
  readonly slot: string;
}

type AttributedMemoryMessage = ModelMessage & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export function attributeMemoryMessage(
  message: ModelMessage,
  attribution: InternalMemoryMessageAttribution,
): ModelMessage {
  const attributed: AttributedMemoryMessage = {
    ...message,
    metadata: {
      ...readMetadata(message),
      [MEMORY_MESSAGE_METADATA_KEY]: attribution,
    },
  } as AttributedMemoryMessage;
  return attributed;
}

export function readMemoryMessageAttribution(
  message: unknown,
): InternalMemoryMessageAttribution | null {
  if (typeof message !== "object" || message === null) return null;
  const metadata = Reflect.get(message, "metadata");
  if (typeof metadata !== "object" || metadata === null) return null;
  const candidate = Reflect.get(metadata, MEMORY_MESSAGE_METADATA_KEY);
  if (typeof candidate !== "object" || candidate === null) return null;
  const scope = Reflect.get(candidate, "scope");
  const slot = Reflect.get(candidate, "slot");
  if (typeof scope !== "object" || scope === null || typeof slot !== "string") return null;
  const key = Reflect.get(scope, "key");
  const namespace = Reflect.get(scope, "namespace");
  const value = Reflect.get(scope, "value");
  if (typeof key !== "string" || typeof namespace !== "string" || typeof value !== "string") {
    return null;
  }
  return { scope: { key, namespace, value }, slot };
}

/** Removes eve-owned recall attribution before a message crosses the model boundary. */
export function stripMemoryMessageAttribution(message: ModelMessage): ModelMessage {
  const metadata = readMetadata(message);
  if (!Object.hasOwn(metadata, MEMORY_MESSAGE_METADATA_KEY)) return message;

  const { [MEMORY_MESSAGE_METADATA_KEY]: _attribution, ...remainingMetadata } = metadata;
  const { metadata: _metadata, ...plain } = message as AttributedMemoryMessage;
  if (Object.keys(remainingMetadata).length === 0) return plain as ModelMessage;
  const sanitized = { ...plain, metadata: remainingMetadata } as AttributedMemoryMessage;
  return sanitized;
}

function readMetadata(message: ModelMessage): Readonly<Record<string, unknown>> {
  const metadata = Reflect.get(message, "metadata");
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Readonly<Record<string, unknown>>)
    : {};
}
