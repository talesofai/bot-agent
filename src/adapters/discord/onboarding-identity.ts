export type DiscordOnboardingIdentityRoleConfig = {
  creatorRoleIds: string[];
  playerRoleIds: string[];
  /** Lowercased; matched by substring (contains). */
  creatorRoleNameIncludes: string[];
  /** Lowercased; matched by substring (contains). */
  playerRoleNameIncludes: string[];
};

export type DiscordIdentityRoles = { creator: boolean; player: boolean };

function parseCsv(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeLower(input: string): string {
  return input.trim().toLowerCase();
}

function anyRoleNameIncludes(
  memberRoleNamesLower: string[],
  needlesLower: string[],
): boolean {
  if (needlesLower.length === 0) {
    return false;
  }
  return memberRoleNamesLower.some((name) =>
    needlesLower.some((needle) => needle && name.includes(needle)),
  );
}

export function buildDiscordOnboardingIdentityRoleConfig(input: {
  creatorRoleIdsRaw?: string | null;
  playerRoleIdsRaw?: string | null;
  creatorRoleNamesRaw?: string | null;
  playerRoleNamesRaw?: string | null;
}): DiscordOnboardingIdentityRoleConfig {
  const creatorRoleIds = parseCsv(input.creatorRoleIdsRaw).filter((id) =>
    /^\d+$/.test(id),
  );
  const playerRoleIds = parseCsv(input.playerRoleIdsRaw).filter((id) =>
    /^\d+$/.test(id),
  );
  const creatorRoleNameIncludes = parseCsv(input.creatorRoleNamesRaw).map(
    normalizeLower,
  );
  const playerRoleNameIncludes = parseCsv(input.playerRoleNamesRaw).map(
    normalizeLower,
  );
  return {
    creatorRoleIds,
    playerRoleIds,
    creatorRoleNameIncludes,
    playerRoleNameIncludes,
  };
}

export function resolveDiscordIdentityRoles(input: {
  memberRoleIds: string[];
  memberRoleNames: string[];
  config: DiscordOnboardingIdentityRoleConfig;
}): DiscordIdentityRoles {
  const roleIdSet = new Set(input.memberRoleIds.map((id) => id.trim()));
  const roleNamesLower = input.memberRoleNames
    .map(normalizeLower)
    .filter(Boolean);

  const hasBoth = roleNamesLower.some(
    (name) =>
      name.includes("both") ||
      name.includes("create and play") ||
      name.includes("既创作") ||
      name.includes("也游玩"),
  );
  if (hasBoth) {
    return { creator: true, player: true };
  }

  const hasExplicitConfig =
    input.config.creatorRoleIds.length > 0 ||
    input.config.playerRoleIds.length > 0 ||
    input.config.creatorRoleNameIncludes.length > 0 ||
    input.config.playerRoleNameIncludes.length > 0;

  if (hasExplicitConfig) {
    const creator =
      input.config.creatorRoleIds.some((id) => roleIdSet.has(id)) ||
      anyRoleNameIncludes(roleNamesLower, input.config.creatorRoleNameIncludes);
    const player =
      input.config.playerRoleIds.some((id) => roleIdSet.has(id)) ||
      anyRoleNameIncludes(roleNamesLower, input.config.playerRoleNameIncludes);
    return { creator, player };
  }

  // Heuristics (fallback): try to match common role names from Discord onboarding options.
  const creator = roleNamesLower.some(
    (name) =>
      name.includes("worldbuilder") ||
      name.includes("writer") ||
      name.includes("creator") ||
      name.includes("world creator") ||
      name.includes("world creater") ||
      name.includes("creater") ||
      name.includes("创作者") ||
      name.includes("写手"),
  );
  const player = roleNamesLower.some(
    (name) =>
      name.includes("roleplay") ||
      name.includes("explore") ||
      name.includes("player") ||
      name.includes("adventurer") ||
      name.includes("玩家") ||
      name.includes("跑团"),
  );

  return { creator, player };
}
