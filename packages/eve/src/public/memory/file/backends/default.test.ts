import { get, put } from "#compiled/@vercel/blob/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultFileMemoryBackend } from "#public/memory/file/backends/default.js";

vi.mock("#compiled/@vercel/blob/index.js", () => ({
  BlobPreconditionFailedError: class BlobPreconditionFailedError extends Error {},
  get: vi.fn(),
  put: vi.fn(),
}));

const signal = new AbortController().signal;

describe("default file-memory backend", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses process-local storage outside Vercel and caches that selection", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "development");
    const backend = defaultFileMemoryBackend();
    await backend.write({ content: "local", expectedVersion: null, key: "mem_a", signal });
    vi.stubEnv("VERCEL", "1");

    await expect(backend.read({ key: "mem_a", signal })).resolves.toMatchObject({
      content: "local",
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("defers Vercel Blob selection until the first operation", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "production");
    const backend = defaultFileMemoryBackend();
    vi.stubEnv("VERCEL", "1");
    vi.mocked(get).mockResolvedValue(null);

    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ access: "private", useCache: false }),
    );
  });

  it("requires an explicit backend in non-Vercel production", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "production");
    const backend = defaultFileMemoryBackend();

    await expect(async () => await backend.read({ key: "mem_a", signal })).rejects.toThrow(
      "requires an explicit backend outside Vercel in production",
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
