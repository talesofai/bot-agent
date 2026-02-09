import type { APIEmbed } from "discord.js";
import type { UserLanguage } from "../../user/state-store";
import {
  clampText,
  extractCharacterCardField,
  extractCharacterCardSection,
  extractWorldCardField,
  extractWorldOneLiner,
  normalizeForumTagName,
  parseWorldCardTagKeywords,
} from "./card-parsers";

export function parseWorldSubmissionMarkdown(content: string): {
  kind?: "canon" | "chronicle" | "task" | "news";
  title?: string;
  submitterUserId?: string;
  content?: string;
} | null {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  let kind: "canon" | "chronicle" | "task" | "news" | undefined;
  let title: string | undefined;
  let submitterUserId: string | undefined;
  let contentStart = -1;
  for (let i = 0; i < Math.min(lines.length, 80); i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    const kindMatch = line.match(/^-\s*(?:类型|Type)\s*[:：]\s*(\w+)\s*$/);
    if (kindMatch) {
      const raw = kindMatch[1]?.trim();
      if (
        raw === "canon" ||
        raw === "chronicle" ||
        raw === "task" ||
        raw === "news"
      ) {
        kind = raw;
      }
      continue;
    }
    const titleMatch = line.match(/^-\s*(?:标题|Title)\s*[:：]\s*(.+)$/);
    if (titleMatch) {
      title = titleMatch[1]?.trim() || undefined;
      continue;
    }
    const submitterMatch = line.match(
      /^-\s*(?:提交者|Submitter)\s*[:：]\s*<@(\d+)>\s*$/,
    );
    if (submitterMatch) {
      submitterUserId = submitterMatch[1]?.trim() || undefined;
      continue;
    }
    if (line === "## 内容" || line === "## Content") {
      contentStart = i + 1;
      break;
    }
  }

  const body =
    contentStart >= 0 ? lines.slice(contentStart).join("\n").trim() : undefined;

  return { kind, title, submitterUserId, content: body };
}

export function buildWorldShowcaseForumOpener(input: {
  worldId: number;
  worldName: string;
  creatorId: string;
  language: UserLanguage | null;
  card: string | null;
}): string {
  const summary = extractWorldOneLiner(input.card);
  const tags = extractWorldCardField(input.card, {
    zh: "类型标签",
    en: "Tags",
  });
  const creator = input.creatorId.trim()
    ? `<@${input.creatorId}>`
    : "(unknown)";
  if (input.language === "en") {
    return [
      `World published: W${input.worldId} ${input.worldName}`,
      summary ? `One-liner: ${summary}` : null,
      tags ? `Tags: ${tags}` : null,
      `Join: /world join world_id:${input.worldId}`,
      `Creator: ${creator}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
  return [
    `世界已发布：W${input.worldId} ${input.worldName}`,
    summary ? `一句话：${summary}` : null,
    tags ? `类型标签：${tags}` : null,
    `加入：/world join world_id:${input.worldId}`,
    `创作者：${creator}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildWorldShowcasePost(input: {
  worldId: number;
  worldName: string;
  creatorId: string;
  language: UserLanguage | null;
  card: string | null;
  rules: string | null;
}): { content: string; embeds: APIEmbed[] } {
  const creator = input.creatorId.trim()
    ? `<@${input.creatorId}>`
    : "(unknown)";
  const summary = extractWorldOneLiner(input.card);
  const tags = extractWorldCardField(input.card, {
    zh: "类型标签",
    en: "Tags",
  });
  const era = extractWorldCardField(input.card, {
    zh: "时代背景",
    en: "Era / Setting",
  });
  const tone = extractWorldCardField(input.card, {
    zh: "整体氛围",
    en: "Overall Tone",
  });
  const core = extractWorldCardField(input.card, {
    zh: "核心元素",
    en: "Core Elements",
  });
  const safeCore = core ? clampText(core, 800) : null;
  const safeCard = input.card?.trim() ? clampText(input.card.trim(), 1400) : "";
  const safeRules = input.rules?.trim()
    ? clampText(input.rules.trim(), 1200)
    : "";

  const join = `/world join world_id:${input.worldId}`;
  const embed: APIEmbed = {
    title: `W${input.worldId} ${input.worldName}`,
    description: summary ?? undefined,
    fields: [
      ...(tags
        ? [{ name: input.language === "en" ? "Tags" : "类型标签", value: tags }]
        : []),
      ...(era
        ? [
            {
              name: input.language === "en" ? "Era / Setting" : "时代背景",
              value: era,
            },
          ]
        : []),
      ...(tone
        ? [
            {
              name: input.language === "en" ? "Overall Tone" : "整体氛围",
              value: tone,
            },
          ]
        : []),
      ...(safeCore
        ? [
            {
              name: input.language === "en" ? "Core Elements" : "核心元素",
              value: safeCore,
            },
          ]
        : []),
      { name: input.language === "en" ? "Creator" : "创作者", value: creator },
      { name: input.language === "en" ? "Join" : "加入", value: `\`${join}\`` },
    ],
    footer: {
      text:
        input.language === "en"
          ? "Creator: reply with an image + #cover to set cover."
          : "创作者：回复图片并带 #cover（或“封面”）即可设置封面。",
    },
  };

  const intro =
    input.language === "en"
      ? [
          `Creator: ${creator}`,
          `Join: \`${join}\``,
          "Post your onboarding / images in this thread.",
          "Set cover: reply with an image and include `#cover`.",
        ].join("\n")
      : [
          `创作者：${creator}`,
          `加入：\`${join}\``,
          "你可以在本帖继续补充引导/图片/链接。",
          "设置封面：创作者回复图片并带 `#cover`（或“封面”）。",
        ].join("\n");
  const content = clampText(
    [
      intro,
      safeCard
        ? input.language === "en"
          ? "## World Lore (Excerpt)"
          : "## 世界设定（节选）"
        : null,
      safeCard || null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n"),
    1900,
  );

  const embeds: APIEmbed[] = [embed];
  if (safeRules) {
    embeds.push({
      title:
        input.language === "en" ? "World Rules (Excerpt)" : "世界规则（节选）",
      description: safeRules,
    });
  }
  return { content, embeds };
}

export function buildWorldDiscussionGuide(input: {
  worldId: number;
  worldName: string;
  forumChannelId: string;
}): string {
  return [
    `# World Discussion Guide · W${input.worldId} ${input.worldName}`,
    "",
    "This channel is for in-character and out-of-character conversation inside this world.",
    "",
    "Use this channel to:",
    "- Start or continue roleplay scenes",
    "- Ask quick lore clarifications",
    "- Coordinate cross-character interactions",
    "- Share session notes and follow-up ideas",
    "",
    `Topic posts / world introductions: use <#${input.forumChannelId}>.`,
    "Please avoid posting formal rule/progression proposals here.",
    "For structured changes, use #world-proposals.",
  ].join("\n");
}

export function buildWorldProposalsGuide(input: {
  worldId: number;
  worldName: string;
}): string {
  return [
    `# World Proposals Guide · W${input.worldId} ${input.worldName}`,
    "",
    "This channel is for structured, reviewable world updates.",
    "",
    "Use this channel to propose:",
    "- Canon additions or revisions",
    "- Timeline/chronicle entries",
    "- Rule changes",
    "- Event/task definitions",
    "",
    "Proposal template:",
    "- Type: canon | chronicle | task | news",
    "- Title:",
    "- Content:",
    "",
    "Keep one proposal per thread when possible.",
  ].join("\n");
}

export function buildCharacterShowcaseThreadContent(input: {
  characterId: number;
  characterName: string;
  creatorId: string;
  card: string | null;
}): string {
  const creator = input.creatorId.trim()
    ? `<@${input.creatorId}>`
    : "(unknown)";
  const notes = extractCharacterCardField(input.card, {
    zh: "补充",
    en: "Notes",
  });
  const appearance = extractCharacterCardSection(input.card, {
    zh: "外貌",
    en: "Appearance",
  });
  const personality = extractCharacterCardSection(input.card, {
    zh: "性格",
    en: "Personality",
  });
  const background = extractCharacterCardSection(input.card, {
    zh: "背景",
    en: "Background",
  });

  return clampText(
    [
      `Character published: C${input.characterId} ${input.characterName}`,
      `Creator: ${creator}`,
      notes ? `Notes: ${notes}` : null,
      "",
      appearance ? "## Appearance" : null,
      appearance || null,
      personality ? "## Personality" : null,
      personality || null,
      background ? "## Background" : null,
      background || null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    1800,
  );
}

export function buildWorldShowcaseForumTags(): Array<{ name: string }> {
  return [
    { name: "Fantasy" },
    { name: "Sci-Fi" },
    { name: "Modern" },
    { name: "Horror" },
    { name: "Historical" },
    { name: "Anime" },
    { name: "Active" },
  ];
}

export function resolveForumAppliedTagIds(input: {
  channel: unknown;
  card: string | null;
}): string[] {
  const rawAvailable = (input.channel as { availableTags?: unknown })
    .availableTags;
  if (!Array.isArray(rawAvailable) || rawAvailable.length === 0) {
    return [];
  }

  const candidates = rawAvailable
    .map((tag) => {
      const id =
        tag && typeof tag === "object" && "id" in tag
          ? String((tag as { id?: unknown }).id ?? "").trim()
          : "";
      const name =
        tag && typeof tag === "object" && "name" in tag
          ? String((tag as { name?: unknown }).name ?? "").trim()
          : "";
      return {
        id,
        name,
        normalizedName: normalizeForumTagName(name),
      };
    })
    .filter((tag) => tag.id && tag.normalizedName);
  if (candidates.length === 0) {
    return [];
  }

  const rawTags = extractWorldCardField(input.card, {
    zh: "类型标签",
    en: "Tags",
  });
  const desired = parseWorldCardTagKeywords(rawTags);
  if (desired.length === 0) {
    return [];
  }

  const matched: string[] = [];
  for (const keyword of desired) {
    const hit = candidates.find(
      (candidate) => candidate.normalizedName === keyword,
    );
    if (!hit) {
      continue;
    }
    if (matched.includes(hit.id)) {
      continue;
    }
    matched.push(hit.id);
    if (matched.length >= 5) {
      break;
    }
  }
  return matched;
}
