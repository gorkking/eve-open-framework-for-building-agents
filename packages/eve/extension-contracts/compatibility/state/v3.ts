import { defineState } from "#public/context/index.js";

export const egressAudit = defineState("compatibility.egressAudit", () => ({
  lockedDown: false,
  reason: "unset",
}));

export function recordLockdown(reason: string): void {
  egressAudit.update(() => ({ lockedDown: true, reason }));
}
