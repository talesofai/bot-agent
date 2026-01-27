import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { WorldFileStore } from "../file-store";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "world-file-store-test-"));
}

describe("WorldFileStore source documents", () => {
  test("writeSourceDocument writes latest + archived copy", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      const result = await store.writeSourceDocument(1, {
        filename: "My World.md",
        content: "hello world",
      });

      expect(result.latestPath.endsWith("/worlds/1/source.md")).toBe(true);
      expect(result.archivedPath.includes("/worlds/1/sources/")).toBe(true);
      expect(result.archivedPath.endsWith("my-world.md")).toBe(true);

      expect(readFileSync(result.latestPath, "utf8")).toContain("hello world");
      expect(readFileSync(result.archivedPath, "utf8")).toContain(
        "hello world",
      );

      const latest = await store.readSourceDocument(1);
      expect(latest).toContain("hello world");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
