interface VercelRequestContext {
  readonly headers?: Readonly<Record<string, string | undefined>>;
}

interface VercelRequestContextProvider {
  get?(): VercelRequestContext;
}

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/** Reads the ambient token injected into a deployed Vercel function. */
export async function getVercelOidcToken(): Promise<string> {
  const provider = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as
    | VercelRequestContextProvider
    | undefined;
  const token = provider?.get?.().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error("The 'x-vercel-oidc-token' header is missing from the request.");
  }
  return token;
}
