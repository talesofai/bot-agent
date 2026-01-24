import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getConfig } from "../config";
import { isSafePathSegment } from "../utils/path";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BUILTIN_SKILLS_DIR = path.join(PROJECT_ROOT, "configs", "skills");
const SKILLS_SYNC_STATE_FILE = ".opencode-skills-sync.json";

export interface EnsureOpencodeSkillsOptions {
  workspacePath: string;
  groupId: string;
  botId: string;
}

export async function ensureOpencodeSkills(
  options: EnsureOpencodeSkillsOptions,
): Promise<void> {
  const config = getConfig();
  const dataRoot = resolveDataRoot(config);

  const sources: string[] = [
    BUILTIN_SKILLS_DIR,
    path.join(dataRoot, "global", "skills"),
  ];
  if (options.groupId !== "0") {
    sources.push(path.join(config.GROUPS_DATA_DIR, options.groupId, "skills"));
  }
  sources.push(path.join(dataRoot, "bots", options.botId, "skills"));

  const targetRoot = path.join(options.workspacePath, ".claude", "skills");
  await mkdir(targetRoot, { recursive: true });
  const syncStatePath = path.join(targetRoot, SKILLS_SYNC_STATE_FILE);

  const builtinExists = await exists(BUILTIN_SKILLS_DIR);
  if (!builtinExists) {
    throw new Error(
      `Missing built-in skills directory at ${BUILTIN_SKILLS_DIR}; please include configs/skills in the image`,
    );
  }

  const syncState = await resolveSyncState(sources);
  if (await isSyncStateFresh(syncStatePath, syncState)) {
    return;
  }

  await removeOrphanSkills(targetRoot, syncState.skillNames);

  for (const sourceRoot of sources) {
    const skillNames = await listSkillDirs(sourceRoot);
    for (const skillName of skillNames) {
      const srcDir = path.join(sourceRoot, skillName);
      const destDir = path.join(targetRoot, skillName);
      await rm(destDir, { recursive: true, force: true });
      await cp(srcDir, destDir, { recursive: true });
    }
  }

  await writeFile(syncStatePath, syncState.fingerprint, "utf8");
}

function resolveDataRoot(config: ReturnType<typeof getConfig>): string {
  const explicit = config.DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  return path.dirname(config.GROUPS_DATA_DIR);
}

async function listSkillDirs(root: string): Promise<string[]> {
  let rootStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    rootStat = await stat(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const skillDirs = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      isSafePathSegment(entry.name),
  );

  const results: string[] = [];
  for (const entry of skillDirs) {
    const skillDir = path.join(root, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (await exists(skillFile)) {
      results.push(entry.name);
    }
  }
  return results;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveSyncState(sources: string[]): Promise<{
  fingerprint: string;
  skillNames: Set<string>;
}> {
  const normalizedSources = [...sources].sort((a, b) => a.localeCompare(b));

  const snapshots = await Promise.all(
    normalizedSources.map(async (sourceRoot) => {
      const skillNames = await listSkillDirs(sourceRoot);
      const entries = await Promise.all(
        skillNames
          .sort((a, b) => a.localeCompare(b))
          .map(async (name) => {
            const skillFile = path.join(sourceRoot, name, "SKILL.md");
            try {
              const fileStat = await stat(skillFile);
              return {
                name,
                skillFileMtimeMs: fileStat.mtimeMs,
                skillFileSize: fileStat.size,
              };
            } catch {
              return { name, skillFileMtimeMs: 0, skillFileSize: 0 };
            }
          }),
      );
      return { sourceRoot, skills: entries };
    }),
  );

  const fingerprint = JSON.stringify({ version: 1, snapshots });
  const allSkillNames = new Set<string>();
  for (const snapshot of snapshots) {
    for (const skill of snapshot.skills) {
      allSkillNames.add(skill.name);
    }
  }
  return { fingerprint, skillNames: allSkillNames };
}

async function isSyncStateFresh(
  syncStatePath: string,
  syncState: { fingerprint: string; skillNames: Set<string> },
): Promise<boolean> {
  let existing: string | null = null;
  try {
    existing = await readFile(syncStatePath, "utf8");
  } catch {
    return false;
  }
  if (existing !== syncState.fingerprint) {
    return false;
  }

  for (const skillName of syncState.skillNames) {
    const expectedSkillFile = path.join(
      path.dirname(syncStatePath),
      skillName,
      "SKILL.md",
    );
    if (!(await exists(expectedSkillFile))) {
      return false;
    }
  }

  return true;
}

async function removeOrphanSkills(
  targetRoot: string,
  desiredSkillNames: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(targetRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const removable = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      isSafePathSegment(entry.name) &&
      !desiredSkillNames.has(entry.name),
  );
  await Promise.all(
    removable.map(async (entry) => {
      await rm(path.join(targetRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }),
  );
}
