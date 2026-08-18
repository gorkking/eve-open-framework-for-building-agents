import { useState } from "react";
import { useEveAgent, type EveMessagePart } from "eve/react";

import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "eve + React Router" }, { name: "description", content: "eve agent chat MVP" }];
}

function MessagePartView({ part }: { part: EveMessagePart }) {
  if (part.type === "text") {
    return <p className="whitespace-pre-wrap">{part.text}</p>;
  }

  if (part.type === "reasoning") {
    return (
      <details className="text-sm text-gray-500 dark:text-gray-400">
        <summary className="cursor-pointer select-none">Reasoning</summary>
        <p className="whitespace-pre-wrap">{part.text}</p>
      </details>
    );
  }

  if (part.type === "dynamic-tool") {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900">
        <div className="font-semibold">tool: {part.toolName}</div>
        <div>input: {JSON.stringify(part.input)}</div>
        {part.state === "output-available" ? (
          <div>output: {JSON.stringify(part.output)}</div>
        ) : (
          <div>state: {part.state}</div>
        )}
      </div>
    );
  }

  return null;
}

export default function Home() {
  const agent = useEveAgent();
  const [draft, setDraft] = useState("");

  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  const submit = () => {
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    void agent.send(text);
  };

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">eve + React Router</h1>
        <span className="text-sm text-gray-500 dark:text-gray-400" data-testid="status">
          {agent.status}
        </span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto" data-testid="messages">
        {agent.data.messages.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">
            Ask about the weather to exercise the agent's tool.
          </p>
        ) : (
          agent.data.messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-12 rounded-lg bg-blue-50 p-3 dark:bg-blue-950"
                  : "mr-12 rounded-lg bg-gray-100 p-3 dark:bg-gray-800"
              }
            >
              <div className="mb-1 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
                {message.role}
              </div>
              <div className="space-y-2">
                {message.parts.map((part, index) => (
                  <MessagePartView key={index} part={part} />
                ))}
              </div>
            </div>
          ))
        )}
        {agent.error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{agent.error.message}</p>
        ) : null}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          className="flex-1 rounded border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
          placeholder="What's the weather in Paris?"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {isBusy ? (
          <button
            type="button"
            className="rounded border border-gray-300 px-4 py-2 dark:border-gray-700"
            onClick={() => void agent.cancel()}
          >
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
            disabled={draft.trim().length === 0}
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}
