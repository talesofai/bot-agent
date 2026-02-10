import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionInfo } from "../types/session";
import { parseCharacterGroup } from "../character/ids";
import { parseWorldGroup } from "../world/ids";
import { WorldFileStore } from "../world/file-store";
import { WorldStore } from "../world/store";

export type ParsedWorldGroup = NonNullable<ReturnType<typeof parseWorldGroup>>;
export type ParsedCharacterGroup = NonNullable<
  ReturnType<typeof parseCharacterGroup>
>;
export type ParsedWorldBuildCharacterGroup = Extract<
  ReturnType<typeof parseCharacterGroup>,
  { kind: "world_build" }
>;

export interface SessionWorkspaceDeps {
  worldStore: WorldStore;
  worldFiles: WorldFileStore;
}

export async function ensureWorkspaceBindingsWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
): Promise<void> {
  const character = parseCharacterGroup(sessionInfo.meta.groupId);
  if (character?.kind === "world_build") {
    await ensureWorldCharacterBuildWorkspaceWithDeps(
      deps,
      sessionInfo,
      character,
    );
    return;
  }

  const world = parseWorldGroup(sessionInfo.meta.groupId);
  if (world) {
    await ensureWorldWorkspaceWithDeps(deps, sessionInfo, world);
    return;
  }
  if (character?.kind === "build") {
    await ensureCharacterWorkspaceWithDeps(deps, sessionInfo, character);
  }
}

export async function ensureWorldCharacterBuildWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
  parsed: ParsedWorldBuildCharacterGroup,
): Promise<void> {
  const worldId = parsed.worldId;
  const characterId = parsed.characterId;

  const worldDir = path.join(sessionInfo.workspacePath, "world");
  const characterDir = path.join(sessionInfo.workspacePath, "character");
  await Promise.all([
    mkdir(worldDir, { recursive: true }),
    mkdir(characterDir, { recursive: true }),
  ]);

  const [card, rules, source, characterCard, characterSource] =
    await Promise.all([
      deps.worldFiles.readWorldCard(worldId),
      deps.worldFiles.readRules(worldId),
      deps.worldFiles.readSourceDocument(worldId),
      deps.worldFiles.readCharacterCard(characterId),
      deps.worldFiles.readCharacterSourceDocument(characterId),
    ]);

  await Promise.all([
    atomicWrite(
      path.join(worldDir, "world-card.md"),
      card ?? `# 世界卡（W${worldId}）\n`,
    ),
    atomicWrite(
      path.join(worldDir, "rules.md"),
      rules ?? `# 世界规则（W${worldId}）\n`,
    ),
    atomicWrite(
      path.join(characterDir, "character-card.md"),
      characterCard ?? `# 角色卡（C${characterId}）\n`,
    ),
  ]);

  const sourcePath = path.join(worldDir, "source.md");
  if (source?.trim()) {
    await atomicWrite(sourcePath, source);
  } else {
    await rm(sourcePath, { force: true });
  }

  const characterSourcePath = path.join(characterDir, "source.md");
  if (characterSource?.trim()) {
    await atomicWrite(characterSourcePath, characterSource);
  } else {
    await rm(characterSourcePath, { force: true });
  }
}

export async function ensureWorldWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
  parsed: ParsedWorldGroup,
): Promise<void> {
  const worldId = parsed.worldId;

  const worldDir = path.join(sessionInfo.workspacePath, "world");
  await mkdir(worldDir, { recursive: true });

  const [card, rules, source] = await Promise.all([
    deps.worldFiles.readWorldCard(worldId),
    deps.worldFiles.readRules(worldId),
    parsed.kind === "build"
      ? deps.worldFiles.readSourceDocument(worldId)
      : null,
  ]);

  await Promise.all([
    atomicWrite(
      path.join(worldDir, "world-card.md"),
      card ?? `# 世界卡（W${worldId}）\n`,
    ),
    atomicWrite(
      path.join(worldDir, "rules.md"),
      rules ?? `# 世界规则（W${worldId}）\n`,
    ),
  ]);

  const sourcePath = path.join(worldDir, "source.md");
  if (parsed.kind === "build") {
    if (source?.trim()) {
      await atomicWrite(sourcePath, source);
    } else {
      await rm(sourcePath, { force: true });
    }
    await rm(path.join(worldDir, "active-character.md"), { force: true });
    return;
  }

  await rm(sourcePath, { force: true });

  const activeCharacterId = await deps.worldStore.getActiveCharacterId({
    worldId,
    userId: sessionInfo.meta.ownerId,
  });
  const activePath = path.join(worldDir, "active-character.md");
  if (!activeCharacterId) {
    await rm(activePath, { force: true });
    return;
  }
  const activeCharacterCard =
    await deps.worldFiles.readCharacterCard(activeCharacterId);
  if (!activeCharacterCard) {
    await rm(activePath, { force: true });
    return;
  }
  await atomicWrite(activePath, activeCharacterCard);
}

export async function ensureCharacterWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
  parsed: ParsedCharacterGroup,
): Promise<void> {
  const characterId = parsed.characterId;
  const dir = path.join(sessionInfo.workspacePath, "character");
  await mkdir(dir, { recursive: true });

  const [card, source] = await Promise.all([
    deps.worldFiles.readCharacterCard(characterId),
    deps.worldFiles.readCharacterSourceDocument(characterId),
  ]);
  await atomicWrite(
    path.join(dir, "character-card.md"),
    card ?? `# 角色卡（C${characterId}）\n`,
  );

  const sourcePath = path.join(dir, "source.md");
  if (source?.trim()) {
    await atomicWrite(sourcePath, source);
  } else {
    await rm(sourcePath, { force: true });
  }
}

export async function syncWorkspaceFilesFromWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
): Promise<string[]> {
  const character = parseCharacterGroup(sessionInfo.meta.groupId);
  if (character?.kind === "world_build") {
    return syncWorldCharacterBuildFilesFromWorkspaceWithDeps(
      deps,
      sessionInfo,
      character,
    );
  }

  const world = parseWorldGroup(sessionInfo.meta.groupId);
  if (world) {
    return syncWorldFilesFromWorkspaceWithDeps(deps, sessionInfo, world);
  }
  if (character?.kind === "build") {
    return syncCharacterFilesFromWorkspaceWithDeps(
      deps,
      sessionInfo,
      character,
    );
  }
  return [];
}

export async function syncWorldCharacterBuildFilesFromWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
  parsed: ParsedWorldBuildCharacterGroup,
): Promise<string[]> {
  const characterId = parsed.characterId;
  const meta = await deps.worldStore.getCharacter(characterId);
  if (!meta) {
    throw new Error(`角色不存在：C${characterId}`);
  }
  if (meta.creatorId !== sessionInfo.meta.ownerId) {
    throw new Error("无权限：只有角色创作者可以修改角色卡。");
  }

  const dir = path.join(sessionInfo.workspacePath, "character");
  const workspacePath = path.join(dir, "character-card.md");
  const workspaceCard = await readOptionalUtf8(workspacePath);
  const storedCard = await deps.worldFiles.readCharacterCard(characterId);

  if (
    !workspaceCard?.trim() ||
    workspaceCard.trimEnd() === (storedCard ?? "").trimEnd()
  ) {
    return [];
  }

  await deps.worldFiles.writeCharacterCard(characterId, workspaceCard);
  await deps.worldFiles.appendCharacterEvent(characterId, {
    type: "character_card_updated",
    characterId,
    userId: sessionInfo.meta.ownerId,
    groupId: sessionInfo.meta.groupId,
  });
  return ["character/character-card.md"];
}

export async function syncWorldFilesFromWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
  parsed: ParsedWorldGroup,
): Promise<string[]> {
  if (parsed.kind === "play") {
    return [];
  }
  const worldId = parsed.worldId;

  const worldDir = path.join(sessionInfo.workspacePath, "world");
  const readWorkspaceFile = async (filename: string): Promise<string | null> =>
    readOptionalUtf8(path.join(worldDir, filename));

  if (parsed.kind === "build") {
    const meta = await deps.worldStore.getWorld(worldId);
    if (!meta) {
      throw new Error(`世界不存在：W${worldId}`);
    }
    if (meta.creatorId !== sessionInfo.meta.ownerId) {
      throw new Error("无权限：只有世界创作者可以修改世界文件。");
    }

    const [workspaceCard, workspaceRules, storedCard, storedRules] =
      await Promise.all([
        readWorkspaceFile("world-card.md"),
        readWorkspaceFile("rules.md"),
        deps.worldFiles.readWorldCard(worldId),
        deps.worldFiles.readRules(worldId),
      ]);

    const changed: string[] = [];
    if (
      workspaceCard?.trim() &&
      workspaceCard.trimEnd() !== (storedCard ?? "").trimEnd()
    ) {
      await deps.worldFiles.writeWorldCard(worldId, workspaceCard);
      changed.push("world-card.md");
    }
    if (
      workspaceRules?.trim() &&
      workspaceRules.trimEnd() !== (storedRules ?? "").trimEnd()
    ) {
      await deps.worldFiles.writeRules(worldId, workspaceRules);
      changed.push("rules.md");
    }

    if (changed.length > 0) {
      await deps.worldFiles.appendEvent(worldId, {
        type: "world_files_updated",
        worldId,
        userId: sessionInfo.meta.ownerId,
        groupId: sessionInfo.meta.groupId,
        files: changed,
      });
    }

    return changed;
  }
  return [];
}

export async function syncCharacterFilesFromWorkspaceWithDeps(
  deps: SessionWorkspaceDeps,
  sessionInfo: SessionInfo,
  parsed: ParsedCharacterGroup,
): Promise<string[]> {
  const characterId = parsed.characterId;
  const meta = await deps.worldStore.getCharacter(characterId);
  if (!meta) {
    throw new Error(`角色不存在：C${characterId}`);
  }
  if (meta.creatorId !== sessionInfo.meta.ownerId) {
    throw new Error("无权限：只有角色创作者可以修改角色卡。");
  }

  const dir = path.join(sessionInfo.workspacePath, "character");
  const workspacePath = path.join(dir, "character-card.md");
  const workspaceCard = await readOptionalUtf8(workspacePath);
  const storedCard = await deps.worldFiles.readCharacterCard(characterId);

  if (
    !workspaceCard?.trim() ||
    workspaceCard.trimEnd() === (storedCard ?? "").trimEnd()
  ) {
    return [];
  }

  await deps.worldFiles.writeCharacterCard(characterId, workspaceCard);
  await deps.worldFiles.appendCharacterEvent(characterId, {
    type: "character_card_updated",
    characterId,
    userId: sessionInfo.meta.ownerId,
    groupId: sessionInfo.meta.groupId,
  });
  return ["character/character-card.md"];
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((err) => {
    if (err && typeof err === "object" && "code" in err) {
      if ((err as { code?: unknown }).code === "ENOENT") {
        return null;
      }
    }
    throw err;
  });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(
    tmpPath,
    content.endsWith("\n") ? content : `${content}\n`,
    "utf8",
  );
  await rename(tmpPath, filePath);
}
