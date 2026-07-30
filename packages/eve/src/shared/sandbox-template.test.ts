import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  defineSandboxTemplate,
  getSandboxTemplateInternal,
  hasSandboxTemplateReference,
  isSandboxTemplate,
  readSandboxTemplateReference,
  recordSandboxTemplateReference,
  withSandboxTemplateBindings,
} from "#shared/sandbox-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";

describe("defineSandboxTemplate", () => {
  it("keeps provider references internal and supplies the bound build result to create", async () => {
    const sandbox = mockSandbox();
    const create = vi.fn(() => sandbox.session as Sandbox);
    const template = defineSandboxTemplate<{ snapshotId: string }, { resources: number }>({
      async prewarm() {
        return { snapshotId: "snapshot_123" };
      },
      create,
    });

    expect(isSandboxTemplate(template)).toBe(true);
    await expect(template.create({ resources: 2 })).rejects.toThrow(/no prewarmed build result/);

    const internal = getSandboxTemplateInternal(template);

    await expect(
      withSandboxTemplateBindings(
        new Map([[internal, { snapshotId: "snapshot_123" }]]),
        async () => await template.create({ resources: 2 }),
      ),
    ).resolves.toBe(sandbox.session);
    expect(create).toHaveBeenCalledWith({
      options: { resources: 2 },
      reference: { snapshotId: "snapshot_123" },
    });
    await expect(template.create({ resources: 2 })).rejects.toThrow(/no prewarmed build result/);
  });

  it("includes provider-owned preparation options in its private implementation identity", () => {
    const createTemplate = (revision: { image: string; pullPolicy: string }) =>
      defineSandboxTemplate({
        revision,
        async prewarm() {
          return { image: "built" };
        },
        async create() {
          return mockSandbox().session as Sandbox;
        },
      });

    const first = getSandboxTemplateInternal(
      createTemplate({ image: "node:24", pullPolicy: "always" }),
    );
    const reordered = getSandboxTemplateInternal(
      createTemplate({ pullPolicy: "always", image: "node:24" }),
    );
    const changed = getSandboxTemplateInternal(
      createTemplate({ image: "node:25", pullPolicy: "always" }),
    );

    expect(reordered.implementationId).toBe(first.implementationId);
    expect(changed.implementationId).not.toBe(first.implementationId);
  });

  it("scopes references to concurrent definition invocations", async () => {
    const seen: string[] = [];
    const template = defineSandboxTemplate<{ snapshotId: string }, undefined>({
      async prewarm() {
        return { snapshotId: "unused" };
      },
      async create({ reference }) {
        await Promise.resolve();
        seen.push(reference.snapshotId);
        return mockSandbox({ id: reference.snapshotId }).session as Sandbox;
      },
    });
    const internal = getSandboxTemplateInternal(template);

    const [first, second] = await Promise.all([
      withSandboxTemplateBindings(
        new Map([[internal, { snapshotId: "snapshot-a" }]]),
        async () => await template.create(undefined),
      ),
      withSandboxTemplateBindings(
        new Map([[internal, { snapshotId: "snapshot-b" }]]),
        async () => await template.create(undefined),
      ),
    ]);

    expect(first.id).toBe("snapshot-a");
    expect(second.id).toBe("snapshot-b");
    expect(seen).toEqual(expect.arrayContaining(["snapshot-a", "snapshot-b"]));
  });

  it("distinguishes a captured null reference from no captured reference", () => {
    const templateKey = `nullable-template-${randomUUID()}`;

    expect(hasSandboxTemplateReference(templateKey)).toBe(false);
    recordSandboxTemplateReference(templateKey, null);

    expect(hasSandboxTemplateReference(templateKey)).toBe(true);
    expect(readSandboxTemplateReference(templateKey)).toBeNull();
  });
});
