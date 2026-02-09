export type OnboardingComponentAction =
  | "menu"
  | "help"
  | "language_set"
  | "character_create"
  | "character_autopilot"
  | "character_generate_portrait"
  | "character_generate_portrait_ref"
  | "character_publish"
  | "character_show"
  | "world_create"
  | "world_autopilot"
  | "world_show"
  | "world_list"
  | "world_join"
  | "world_publish"
  | "world_select";

const ONBOARDING_CUSTOM_ID_PREFIX = "onb";

export function buildOnboardingCustomId(input: {
  userId: string;
  action: OnboardingComponentAction;
  payload?: string;
}): string {
  const userId = input.userId.trim();
  const payload = input.payload?.trim() ?? "";
  const id = payload
    ? `${ONBOARDING_CUSTOM_ID_PREFIX}:${userId}:${input.action}:${payload}`
    : `${ONBOARDING_CUSTOM_ID_PREFIX}:${userId}:${input.action}`;
  return id.length > 100 ? id.slice(0, 100) : id;
}

export function parseOnboardingCustomId(customId: string): {
  userId: string;
  action: OnboardingComponentAction;
  payload: string;
} | null {
  const parts = customId.split(":");
  if (parts.length < 3) {
    return null;
  }
  const [prefix, userIdRaw, actionRaw, ...rest] = parts;
  if (prefix !== ONBOARDING_CUSTOM_ID_PREFIX) {
    return null;
  }
  const userId = (userIdRaw ?? "").trim();
  if (!userId || !/^\d{16,20}$/.test(userId)) {
    return null;
  }
  const action = (actionRaw ?? "").trim() as OnboardingComponentAction;
  const allowed: OnboardingComponentAction[] = [
    "menu",
    "help",
    "language_set",
    "character_create",
    "character_autopilot",
    "character_generate_portrait",
    "character_generate_portrait_ref",
    "character_publish",
    "character_show",
    "world_create",
    "world_autopilot",
    "world_show",
    "world_list",
    "world_join",
    "world_publish",
    "world_select",
  ];
  if (!allowed.includes(action)) {
    return null;
  }
  return { userId, action, payload: rest.join(":") };
}
