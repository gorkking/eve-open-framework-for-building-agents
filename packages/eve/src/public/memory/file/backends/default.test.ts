import { get, put } from "#compiled/@vercel/blob/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultFileMemoryBackend } from "#public/memory/file/backends/default.js";

vi.mock("#compiled/@vercel/blob/index.js", () => ({
  BlobPreconditionFailedError: class BlobPreconditionFailedError extends Error {},
  get: vi.fn(),
  put: vi.fn(),
}));

const originalVercel = process.env.VERCEL;
const signal = new AbortController().signal;

describe("default file-memory backend", () => {
  afterEach(() => {
    vi.clearAllMocks();
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it("uses process-local storage outside Vercel and caches that selection", async () => {
    delete process.env.VERCEL;
    const backend = defaultFileMemoryBackend();
    await backend.write({ content: "local", expectedVersion: null, key: "mem_a", signal });
    process.env.VERCEL = "1";

    await expect(backend.read({ key: "mem_a", signal })).resolves.toMatchObject({
      content: "local",
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("defers Vercel Blob selection until the first operation", async () => {
    delete process.env.VERCEL;
    const backend = defaultFileMemoryBackend();
    process.env.VERCEL = "1";
    vi.mocked(get).mockResolvedValue(null);

    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ access: "private", useCache: false }),
    );
  });
});
