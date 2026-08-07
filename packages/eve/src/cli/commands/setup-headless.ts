import type { AnyQuestion } from "#setup/ask.js";

export interface HeadlessSetupRefusal {
  status: "input_required" | "prerequisite_required";
  item: string;
  installed: boolean;
  setup_mutated: false;
  question?: AnyQuestion;
  prerequisite?: { code: string; message: string; command: string };
  next: { command: string };
}

function shell(value: string): string {
  return /^[\w@./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatAnswer(key: string, value: unknown): string {
  return `${shell(key)}=${shell(JSON.stringify(value))}`;
}

export function headlessSetupContinuation(input: {
  item: string;
  installed: boolean;
  answers: Readonly<Record<string, unknown>>;
}): string {
  const args = ["eve", "add", shell(input.item), "--headless", "--json"];
  if (input.installed) args.push("--skip-install");
  for (const [key, value] of Object.entries(input.answers)) {
    args.push("--answer", formatAnswer(key, value));
  }
  return args.join(" ");
}

export function formatHeadlessSetupRefusal(refusal: HeadlessSetupRefusal): string {
  return JSON.stringify(refusal);
}
