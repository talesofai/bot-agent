export function patchCreatorLineInMarkdown(
  input: string,
  creatorId: string,
  creatorLabel: string | null,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return input;
  }
  const safeCreatorId = creatorId.trim();
  if (!safeCreatorId) {
    return input;
  }
  const label = (creatorLabel ?? `<@${safeCreatorId}>`).trim();

  const lines = trimmed.split("\n");
  let patched = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const bulletMatch = line.match(
      /^\s*-\s*(创建者|创作者|Creator)\s*[:：]\s*(.+)\s*$/,
    );
    if (bulletMatch) {
      const key = (bulletMatch[1] ?? "").trim();
      const value = (bulletMatch[2] ?? "").trim();
      if (
        !value ||
        value === safeCreatorId ||
        value === `<@${safeCreatorId}>` ||
        /^\d+$/.test(value) ||
        value.includes(safeCreatorId)
      ) {
        lines[i] =
          key === "Creator" ? `- Creator: ${label}` : `- 创建者：${label}`;
        patched = true;
      }
      continue;
    }

    const tableMatch = line.match(
      /^(\s*\|\s*(?:创建者|创作者|Creator)\s*\|\s*)([^|]*?)(\s*\|.*)$/,
    );
    if (!tableMatch) {
      continue;
    }
    const value = (tableMatch[2] ?? "").trim();
    if (
      !value ||
      value === safeCreatorId ||
      value === `<@${safeCreatorId}>` ||
      /^\d+$/.test(value) ||
      value.includes(safeCreatorId)
    ) {
      lines[i] = `${tableMatch[1]}${label}${tableMatch[3]}`;
      patched = true;
    }
  }
  return patched ? lines.join("\n") : input;
}

export function hasWorldForkMarker(card: string, worldId: number): boolean {
  if (!Number.isInteger(worldId) || worldId <= 0) {
    return false;
  }
  const head = card.slice(0, 800);
  const lowered = head.toLowerCase();
  if (!lowered.includes("bot-agent:world_fork")) {
    return false;
  }
  return (
    lowered.includes(`worldid=${String(worldId)}`) ||
    lowered.includes(`worldid:${String(worldId)}`)
  );
}

export function resolveCharacterCardTemplateLanguage(
  card: string,
): "zh" | "en" {
  const head = card.replace(/\r\n/g, "\n").replace(/\r/g, "\n").slice(0, 600);
  if (head.match(/^#\s*Character Card\b/im)) {
    return "en";
  }
  if (head.match(/\bCharacter Card\b/i)) {
    return "en";
  }
  return "zh";
}

export function buildWorldForkedCharacterCard(input: {
  worldId: number;
  worldName: string;
  sourceCharacterId: number;
  forkedCharacterId: number;
  creatorId: string;
  sourceCard: string;
}): string {
  const marker = `<!-- bot-agent:world_fork worldId=${input.worldId} sourceCharacterId=${input.sourceCharacterId} forkedCharacterId=${input.forkedCharacterId} -->`;
  const patched = patchCharacterCardId(
    input.sourceCard,
    input.forkedCharacterId,
  );
  const language = resolveCharacterCardTemplateLanguage(input.sourceCard);
  const header =
    language === "en"
      ? `# Character Card (C${input.forkedCharacterId})`
      : `# 角色卡（C${input.forkedCharacterId}）`;
  return [
    marker,
    header,
    "",
    language === "en"
      ? `- World: W${input.worldId} ${input.worldName}`
      : `- 世界：W${input.worldId} ${input.worldName}`,
    language === "en"
      ? `- Source: forked from C${input.sourceCharacterId}`
      : `- 来源：fork 自 C${input.sourceCharacterId}`,
    language === "en"
      ? `- Creator: ${input.creatorId}`
      : `- 创建者：${input.creatorId}`,
    "",
    stripLeadingCharacterHeader(patched),
  ]
    .join("\n")
    .trimEnd();
}

export function buildAdoptedCharacterCard(input: {
  adoptedCharacterId: number;
  adopterUserId: string;
  mode: "copy" | "fork";
  sourceCharacterId: number;
  sourceCard: string;
}): string {
  const marker = `<!-- bot-agent:character_adopt mode=${input.mode} sourceCharacterId=${input.sourceCharacterId} adoptedCharacterId=${input.adoptedCharacterId} -->`;
  const patched = patchCharacterCardId(
    input.sourceCard,
    input.adoptedCharacterId,
  );
  const language = resolveCharacterCardTemplateLanguage(input.sourceCard);
  const header =
    language === "en"
      ? `# Character Card (C${input.adoptedCharacterId})`
      : `# 角色卡（C${input.adoptedCharacterId}）`;
  return [
    marker,
    header,
    "",
    language === "en"
      ? `- Source: C${input.sourceCharacterId} (${input.mode})`
      : `- 来源：C${input.sourceCharacterId}（${input.mode}）`,
    language === "en"
      ? `- Adopter: ${input.adopterUserId}`
      : `- 采用者：${input.adopterUserId}`,
    "",
    stripLeadingCharacterHeader(patched),
  ]
    .join("\n")
    .trimEnd();
}

export function patchCharacterCardId(
  card: string,
  characterId: number,
): string {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    return card;
  }
  const normalized = card.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  for (let i = 0; i < Math.min(lines.length, 20); i += 1) {
    const line = lines[i] ?? "";
    if (line.match(/^#\s*角色卡\b/)) {
      lines[i] = `# 角色卡（C${characterId}）`;
      return lines.join("\n");
    }
    if (line.match(/^#\s*Character Card\b/i)) {
      lines[i] = `# Character Card (C${characterId})`;
      return lines.join("\n");
    }
  }
  return normalized;
}

export function stripLeadingCharacterHeader(card: string): string {
  const normalized = card.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const lines = normalized.split("\n");
  let idx = 0;
  while (idx < lines.length && lines[idx]?.trim() === "") {
    idx += 1;
  }
  if (
    idx < lines.length &&
    (lines[idx]?.trim().startsWith("# 角色卡") ||
      lines[idx]?.trim().toLowerCase().startsWith("# character card"))
  ) {
    idx += 1;
    while (idx < lines.length && lines[idx]?.trim() === "") {
      idx += 1;
    }
  }
  return lines.slice(idx).join("\n").trimEnd();
}
