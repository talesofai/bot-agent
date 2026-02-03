import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Logger } from "pino";

import {
  GroupConfigSchema,
  type AgentContent,
  AgentFrontmatterSchema,
  type GroupConfig,
  type GroupData,
  type Skill,
} from "../types/group";
import { assertSafePathSegment } from "../utils/path";
import type { UserLanguage } from "../user/state-store";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_AGENT_MD_PATH = join(PROJECT_ROOT, "configs", "default-agent.md");
const DEFAULT_AGENT_EN_MD_PATH = join(
  PROJECT_ROOT,
  "configs",
  "default-agent.en.md",
);

const DEFAULT_CONFIG_YAML = `# 群配置
enabled: true
triggerMode: keyword
keywords: []
keywordRouting:
  enableGlobal: true
  enableGroup: true
  enableBot: true
echoRate: null
adminUsers: []
world:
  createPolicy: admin
  createWhitelist: []
maxSessions: 1
push:
  enabled: false
  time: "09:00"
  timezone: Asia/Shanghai
`;

export interface GroupFileRepositoryOptions {
  dataDir: string;
  logger: Logger;
}

export class GroupFileRepository {
  private dataDir: string;
  private logger: Logger;
  private cachedDefaultAgentZh: string | null = null;
  private cachedDefaultAgentEn: string | null = null;

  constructor(options: GroupFileRepositoryOptions) {
    this.dataDir = options.dataDir;
    this.logger = options.logger.child({ component: "group-repository" });
  }

  async ensureGroupDir(groupId: string): Promise<string> {
    assertSafePathSegment(groupId, "groupId");
    const groupPath = join(this.dataDir, groupId);

    await mkdir(groupPath, { recursive: true });
    await mkdir(join(groupPath, "skills"), { recursive: true });
    await mkdir(join(groupPath, "assets"), { recursive: true });
    await mkdir(join(groupPath, "assets", "images"), { recursive: true });

    const agentPath = join(groupPath, "agent.md");
    if (!(await this.exists(agentPath))) {
      const defaultAgent = await this.loadDefaultAgentTemplate("zh");
      await writeFile(agentPath, defaultAgent);
      this.logger.debug({ groupId }, "Created default agent.md");
    }

    const agentEnPath = join(groupPath, "agent.en.md");
    if (!(await this.exists(agentEnPath))) {
      const defaultAgentEn = await this.loadDefaultAgentTemplate("en");
      await writeFile(agentEnPath, defaultAgentEn);
      this.logger.debug({ groupId }, "Created default agent.en.md");
    }

    const configPath = join(groupPath, "config.yaml");
    if (!(await this.exists(configPath))) {
      await writeFile(configPath, DEFAULT_CONFIG_YAML);
      this.logger.debug({ groupId }, "Created default config.yaml");
    }

    return groupPath;
  }

  private async loadDefaultAgentTemplate(
    language: UserLanguage,
  ): Promise<string> {
    if (language === "en") {
      if (this.cachedDefaultAgentEn !== null) {
        return this.cachedDefaultAgentEn;
      }
    } else {
      if (this.cachedDefaultAgentZh !== null) {
        return this.cachedDefaultAgentZh;
      }
    }
    try {
      const path =
        language === "en" ? DEFAULT_AGENT_EN_MD_PATH : DEFAULT_AGENT_MD_PATH;
      const content = await readFile(path, "utf-8");
      if (language === "en") {
        this.cachedDefaultAgentEn = content;
      } else {
        this.cachedDefaultAgentZh = content;
      }
      return content;
    } catch (err) {
      const path =
        language === "en" ? DEFAULT_AGENT_EN_MD_PATH : DEFAULT_AGENT_MD_PATH;
      throw new Error(
        `Missing default agent template at ${path}; please provide ${
          language === "en"
            ? "configs/default-agent.en.md"
            : "configs/default-agent.md"
        }`,
        { cause: err },
      );
    }
  }

  async loadGroup(groupId: string): Promise<GroupData | null> {
    assertSafePathSegment(groupId, "groupId");
    const groupPath = join(this.dataDir, groupId);

    if (!(await this.exists(groupPath))) {
      return null;
    }

    const [config, agentContent, skills] = await Promise.all([
      this.loadConfig(groupPath),
      this.loadAgentPrompt(groupPath),
      this.loadSkills(groupPath),
    ]);

    return {
      id: groupId,
      path: groupPath,
      config,
      agentPrompt: agentContent.content,
      skills,
    };
  }

  async loadConfig(groupPath: string): Promise<GroupConfig> {
    const configPath = join(groupPath, "config.yaml");

    if (!(await this.exists(configPath))) {
      throw new Error(`Missing config.yaml at ${configPath}`);
    }

    const content = await readFile(configPath, "utf-8");
    const parsed = parseYaml(content);
    return GroupConfigSchema.parse(parsed);
  }

  async saveConfig(groupPath: string, config: GroupConfig): Promise<void> {
    const configPath = join(groupPath, "config.yaml");
    const validated = GroupConfigSchema.parse(config);
    const payload = stringifyYaml(validated).trimEnd();
    const tmpPath = join(
      dirname(configPath),
      `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(tmpPath, `${payload}\n`, "utf-8");
    await rename(tmpPath, configPath);
  }

  async loadAgentPrompt(groupPath: string): Promise<AgentContent> {
    const agentPath = join(groupPath, "agent.md");

    if (!(await this.exists(agentPath))) {
      throw new Error(`Missing agent.md at ${agentPath}`);
    }

    const content = await readFile(agentPath, "utf-8");
    const parsed = this.parseAgentMd(content);
    if (parsed.content.trim() === "" && basename(groupPath) === "0") {
      const defaultAgent = await this.loadDefaultAgentTemplate("zh");
      return this.parseAgentMd(defaultAgent);
    }
    return parsed;
  }

  async loadAgentPromptForLanguage(
    groupPath: string,
    language: UserLanguage | null | undefined,
  ): Promise<AgentContent> {
    if (language === "en") {
      const agentPath = join(groupPath, "agent.en.md");
      if (!(await this.exists(agentPath))) {
        const defaultAgent = await this.loadDefaultAgentTemplate("en");
        return this.parseAgentMd(defaultAgent);
      }
      const content = await readFile(agentPath, "utf-8");
      const parsed = this.parseAgentMd(content);
      if (parsed.content.trim() === "" && basename(groupPath) === "0") {
        const defaultAgent = await this.loadDefaultAgentTemplate("en");
        return this.parseAgentMd(defaultAgent);
      }
      return parsed;
    }
    return this.loadAgentPrompt(groupPath);
  }

  parseAgentMd(content: string): AgentContent {
    try {
      const parsed = matter(content);
      let frontmatter = {};
      try {
        frontmatter = AgentFrontmatterSchema.parse(parsed.data);
      } catch (err) {
        this.logger.warn({ err }, "Invalid agent frontmatter");
      }
      return {
        frontmatter,
        content: parsed.content.trim(),
      };
    } catch (err) {
      this.logger.warn({ err }, "Failed to parse agent.md");
      return {
        frontmatter: {},
        content: content.trim(),
      };
    }
  }

  async loadSkills(groupPath: string): Promise<Record<string, Skill>> {
    const skillsPath = join(groupPath, "skills");

    if (!(await this.exists(skillsPath))) {
      return {};
    }

    const skills: Record<string, Skill> = {};

    try {
      const entries = await readdir(skillsPath, { withFileTypes: true });
      const skillEntries = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md"),
      );

      for (const entry of skillEntries) {
        const skillPath = join(skillsPath, entry.name);
        try {
          const content = await readFile(skillPath, "utf-8");
          const name = basename(entry.name, ".md");
          skills[name] = {
            name,
            content: content.trim(),
            enabled: true,
          };
        } catch (err) {
          this.logger.warn({ err, skillPath }, "Failed to load skill file");
        }
      }
    } catch (err) {
      this.logger.warn({ err, skillsPath }, "Failed to load skills");
    }

    return skills;
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
