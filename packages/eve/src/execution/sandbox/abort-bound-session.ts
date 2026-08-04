import type {
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxReadTextFileOptions,
  SandboxRemovePathOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";

/**
 * Returns a sandbox session that applies `abortSignal` to every operation.
 * Per-call signals are composed with the bound signal.
 */
export function bindSandboxAbortSignal(
  session: SandboxSession,
  abortSignal: AbortSignal,
): SandboxSession {
  // Give backend listeners operation scope instead of attaching them to the long-lived bound signal.
  const createOperationSignal = (callSignal: AbortSignal | undefined): AbortSignal =>
    AbortSignal.any(callSignal === undefined ? [abortSignal] : [abortSignal, callSignal]);

  return {
    ...session,
    run: (options: SandboxRunOptions) =>
      session.run({ ...options, abortSignal: createOperationSignal(options.abortSignal) }),
    spawn: (options: SandboxSpawnOptions) =>
      session.spawn({ ...options, abortSignal: createOperationSignal(options.abortSignal) }),
    readFile: (options: SandboxReadFileOptions) =>
      session.readFile({ ...options, abortSignal: createOperationSignal(options.abortSignal) }),
    readBinaryFile: (options: SandboxReadBinaryFileOptions) =>
      session.readBinaryFile({
        ...options,
        abortSignal: createOperationSignal(options.abortSignal),
      }),
    readTextFile: (options: SandboxReadTextFileOptions) =>
      session.readTextFile({ ...options, abortSignal: createOperationSignal(options.abortSignal) }),
    writeFile: (options: SandboxWriteFileOptions) =>
      session.writeFile({ ...options, abortSignal: createOperationSignal(options.abortSignal) }),
    writeBinaryFile: (options: SandboxWriteBinaryFileOptions) =>
      session.writeBinaryFile({
        ...options,
        abortSignal: createOperationSignal(options.abortSignal),
      }),
    writeTextFile: (options: SandboxWriteTextFileOptions) =>
      session.writeTextFile({
        ...options,
        abortSignal: createOperationSignal(options.abortSignal),
      }),
    removePath: (options: SandboxRemovePathOptions) =>
      session.removePath({ ...options, abortSignal: createOperationSignal(options.abortSignal) }),
  };
}
