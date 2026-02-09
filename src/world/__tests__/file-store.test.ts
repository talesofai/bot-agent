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

  test("appendSourceDocument appends to latest and can write archived chunks", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      await store.writeSourceDocument(1, {
        filename: "base.md",
        content: "base",
      });

      const firstAppend = await store.appendSourceDocument(1, {
        content: "append-1",
      });
      expect(firstAppend.latestPath.endsWith("/worlds/1/source.md")).toBe(true);

      const secondAppend = await store.appendSourceDocument(1, {
        filename: "more.md",
        content: "append-2",
      });

      const latest = await store.readSourceDocument(1);
      expect(latest).toContain("base");
      expect(latest).toContain("append-1");
      expect(latest).toContain("append-2");

      expect(secondAppend.archivedPath).toBeTruthy();
      expect(secondAppend.archivedPath?.includes("/worlds/1/sources/")).toBe(
        true,
      );
      expect(secondAppend.archivedPath?.endsWith("more.md")).toBe(true);
      expect(readFileSync(secondAppend.archivedPath!, "utf8")).toContain(
        "append-2",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("WorldFileStore character source documents", () => {
  test("writeCharacterSourceDocument writes latest + archived copy", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      const result = await store.writeCharacterSourceDocument(1, {
        filename: "My Character.md",
        content: "hello character",
      });

      expect(result.latestPath.endsWith("/characters/1.source.md")).toBe(true);
      expect(result.archivedPath.includes("/characters/sources/1/")).toBe(true);
      expect(result.archivedPath.endsWith("my-character.md")).toBe(true);

      expect(readFileSync(result.latestPath, "utf8")).toContain(
        "hello character",
      );
      expect(readFileSync(result.archivedPath, "utf8")).toContain(
        "hello character",
      );

      const latest = await store.readCharacterSourceDocument(1);
      expect(latest).toContain("hello character");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("appendCharacterSourceDocument appends to latest and can write archived chunks", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      await store.writeCharacterSourceDocument(1, {
        filename: "base.md",
        content: "base",
      });

      const firstAppend = await store.appendCharacterSourceDocument(1, {
        content: "append-1",
      });
      expect(firstAppend.latestPath.endsWith("/characters/1.source.md")).toBe(
        true,
      );

      const secondAppend = await store.appendCharacterSourceDocument(1, {
        filename: "more.md",
        content: "append-2",
      });

      const latest = await store.readCharacterSourceDocument(1);
      expect(latest).toContain("base");
      expect(latest).toContain("append-1");
      expect(latest).toContain("append-2");

      expect(secondAppend.archivedPath).toBeTruthy();
      expect(
        secondAppend.archivedPath?.includes("/characters/sources/1/"),
      ).toBe(true);
      expect(secondAppend.archivedPath?.endsWith("more.md")).toBe(true);
      expect(readFileSync(secondAppend.archivedPath!, "utf8")).toContain(
        "append-2",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("WorldFileStore image assets", () => {
  test("writeWorldImageAsset stores file and updates index", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      const first = await store.writeWorldImageAsset(1, {
        name: " 天空 城 ",
        sourceFilename: "sky.webp",
        uploaderId: "u1",
        contentType: "image/webp",
        bytes: Buffer.from([1, 2, 3, 4]),
      });
      const second = await store.writeWorldImageAsset(1, {
        name: "World Cover",
        sourceFilename: "cover.jpeg",
        uploaderId: "u2",
        bytes: Buffer.from([9, 8, 7]),
      });

      expect(first.relativePath.startsWith("assets/images/")).toBe(true);
      expect(first.filename.endsWith(".webp")).toBe(true);
      expect(first.name).toBe("天空 城");
      expect(second.filename.endsWith(".jpeg")).toBe(true);

      const firstPath = join(tempDir, "worlds", "1", first.relativePath);
      const secondPath = join(tempDir, "worlds", "1", second.relativePath);
      expect(readFileSync(firstPath).byteLength).toBe(4);
      expect(readFileSync(secondPath).byteLength).toBe(3);

      const indexPath = join(
        tempDir,
        "worlds",
        "1",
        "assets",
        "images",
        "index.json",
      );
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{
        name: string;
        filename: string;
        sourceFilename: string;
      }>;
      expect(index.length).toBe(2);
      expect(index[0]?.name).toBe("天空 城");
      expect(index[0]?.sourceFilename).toBe("sky.webp");
      expect(index[1]?.name).toBe("World Cover");
      expect(index[1]?.filename).toBe(second.filename);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("WorldFileStore stats", () => {
  test("ensureMember maintains visitorCount under parallel joins", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      await Promise.all([
        store.ensureMember(1, "u1"),
        store.ensureMember(1, "u2"),
        store.ensureMember(1, "u3"),
      ]);

      const stats = await store.readStats(1);
      expect(stats.visitorCount).toBe(3);

      await store.ensureMember(1, "u1");
      const after = await store.readStats(1);
      expect(after.visitorCount).toBe(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("ensureWorldCharacter maintains characterCount under parallel adds", async () => {
    const tempDir = makeTempDir();
    const logger = pino({ level: "silent" });
    const store = new WorldFileStore({ logger, dataRoot: tempDir });

    try {
      await Promise.all([
        store.ensureWorldCharacter(1, 1),
        store.ensureWorldCharacter(1, 2),
        store.ensureWorldCharacter(1, 3),
      ]);

      const stats = await store.readStats(1);
      expect(stats.characterCount).toBe(3);

      await store.ensureWorldCharacter(1, 2);
      const after = await store.readStats(1);
      expect(after.characterCount).toBe(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
