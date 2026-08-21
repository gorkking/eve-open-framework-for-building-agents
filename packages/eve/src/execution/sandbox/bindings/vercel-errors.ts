export function isVercelSnapshotUnavailableError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    if (status === 410) {
      return true;
    }
  }

  return false;
}

export function isVercelSandboxMissingError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    if (status === 404) {
      return true;
    }
  }

  return false;
}

/** Whether a named sandbox create lost a concurrent create race. */
export function isVercelSandboxAlreadyExistsError(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const status =
      (candidate as { response?: { status?: number } }).response?.status ??
      (candidate as { status?: number }).status ??
      (candidate as { statusCode?: number }).statusCode;
    const providerError = (
      candidate as {
        json?: { error?: { code?: unknown; message?: unknown } };
      }
    ).json?.error;

    if (
      status === 400 &&
      providerError?.code === "bad_request" &&
      typeof providerError.message === "string" &&
      providerError.message.includes("already exists for this project")
    ) {
      return true;
    }
  }

  return false;
}

/** Preserves structured Vercel response details in a user-facing error message. */
export function vercelSandboxErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const responseJson = (error as { readonly json?: unknown }).json;
  const responseText = (error as { readonly text?: unknown }).text;
  const responseBody =
    typeof responseText === "string" && responseText.length > 0
      ? responseText
      : responseJson !== undefined
        ? JSON.stringify(responseJson)
        : undefined;
  return responseBody === undefined ? error.message : `${error.message}: ${responseBody}`;
}

function* walkErrorChain(error: unknown): Generator<unknown> {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}
