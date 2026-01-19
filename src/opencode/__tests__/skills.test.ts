import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetConfig } from "../../config";
import { ensureOpencodeSkills } from "../skills";

async function writeSkill(root: string, name: string, content: string) {
  const skillDir = path.join(root, name);
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  await writeFile(path.join(skillDir, "scripts", "noop.sh"), "echo noop\n", {
    encoding: "utf8",
  });
}

describe("ensureOpencodeSkills", () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalGroupsDir = process.env.GROUPS_DATA_DIR;

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalGroupsDir === undefined) {
      delete process.env.GROUPS_DATA_DIR;
    } else {
      process.env.GROUPS_DATA_DIR = originalGroupsDir;
    }
    resetConfig();
  });

  test("syncs skills with bot > group > global > builtin precedence", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "opencode-skills-"));
    const dataDir = tempRoot;
    const groupsDir = path.join(tempRoot, "groups");
    const workspacePath = path.join(tempRoot, "workspace");
    await mkdir(workspacePath, { recursive: true });

    process.env.DATA_DIR = dataDir;
    process.env.GROUPS_DATA_DIR = groupsDir;
    resetConfig();

    const botId = "discord-123";
    const groupId = "group-1";

    await writeSkill(
      path.join(dataDir, "global", "skills"),
      "url-access-check",
      "---\nname: url-access-check\ndescription: global override\n---\n\nglobal\n",
    );
    await writeSkill(
      path.join(groupsDir, groupId, "skills"),
      "url-access-check",
      "---\nname: url-access-check\ndescription: group override\n---\n\ngroup\n",
    );
    await writeSkill(
      path.join(dataDir, "bots", botId, "skills"),
      "url-access-check",
      "---\nname: url-access-check\ndescription: bot override\n---\n\nbot\n",
    );

    await ensureOpencodeSkills({ workspacePath, groupId, botId });

    const resolved = await readFile(
      path.join(
        workspacePath,
        ".claude",
        "skills",
        "url-access-check",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(resolved).toContain("bot override");
    expect(resolved).toContain("\nbot\n");
  });

  test("does not sync group skills for groupId=0", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "opencode-skills-"));
    const dataDir = tempRoot;
    const groupsDir = path.join(tempRoot, "groups");
    const workspacePath = path.join(tempRoot, "workspace");
    await mkdir(workspacePath, { recursive: true });

    process.env.DATA_DIR = dataDir;
    process.env.GROUPS_DATA_DIR = groupsDir;
    resetConfig();

    const botId = "discord-123";
    const groupId = "0";

    await writeSkill(
      path.join(groupsDir, groupId, "skills"),
      "only-group",
      "---\nname: only-group\ndescription: group only\n---\n\ngroup\n",
    );

    await ensureOpencodeSkills({ workspacePath, groupId, botId });

    const onlyGroupPath = path.join(
      workspacePath,
      ".claude",
      "skills",
      "only-group",
      "SKILL.md",
    );
    await expect(readFile(onlyGroupPath, "utf8")).rejects.toThrow();
  });
});
