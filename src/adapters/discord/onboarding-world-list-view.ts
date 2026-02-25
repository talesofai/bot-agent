import type { ActiveWorldEntry } from "../../world/query";

export const ONBOARDING_WORLD_TOP_COUNT = 3;
export const ONBOARDING_WORLD_PAGE_SIZE = 25;

export type OnboardingWorldListView = {
  totalCount: number;
  totalPages: number;
  page: number;
  topEntries: ActiveWorldEntry[];
  pageEntries: ActiveWorldEntry[];
};

export function buildOnboardingWorldListView(input: {
  entries: ActiveWorldEntry[];
  page?: number;
}): OnboardingWorldListView {
  const totalCount = input.entries.length;
  const totalPages = Math.max(
    1,
    Math.ceil(totalCount / ONBOARDING_WORLD_PAGE_SIZE),
  );
  const requestedPage = Number.isInteger(input.page) ? Number(input.page) : 1;
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const start = (page - 1) * ONBOARDING_WORLD_PAGE_SIZE;
  const end = start + ONBOARDING_WORLD_PAGE_SIZE;

  return {
    totalCount,
    totalPages,
    page,
    topEntries: input.entries.slice(0, ONBOARDING_WORLD_TOP_COUNT),
    pageEntries: input.entries.slice(start, end),
  };
}
