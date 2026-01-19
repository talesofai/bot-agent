import type { SessionElement } from "../types/platform";

const DEFAULT_MAX_IMAGES = 4;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

export function extractOutputElements(
  output: string,
  options?: { maxImages?: number },
): { content: string; elements: SessionElement[] } {
  const maxImages = options?.maxImages ?? DEFAULT_MAX_IMAGES;
  if (!output.trim()) {
    return { content: "", elements: [] };
  }

  const imageUrls: string[] = [];
  const content = stripMarkdownImages(output, imageUrls, maxImages)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (const match of output.matchAll(URL_PATTERN)) {
    if (imageUrls.length >= maxImages) {
      break;
    }
    const candidate = normalizeUrlCandidate(match[0]);
    if (!candidate) {
      continue;
    }
    if (!isImageUrl(candidate)) {
      continue;
    }
    if (imageUrls.includes(candidate)) {
      continue;
    }
    imageUrls.push(candidate);
  }

  return {
    content,
    elements: imageUrls.map((url) => ({ type: "image", url })),
  };
}

function stripMarkdownImages(
  content: string,
  imageUrls: string[],
  maxImages: number,
): string {
  return content.replace(
    MARKDOWN_IMAGE_PATTERN,
    (_match: string, url: string) => {
      if (imageUrls.length >= maxImages) {
        return "";
      }
      const candidate = normalizeUrlCandidate(url);
      if (
        !candidate ||
        !isImageUrl(candidate) ||
        imageUrls.includes(candidate)
      ) {
        return "";
      }
      imageUrls.push(candidate);
      return "";
    },
  );
}

function normalizeUrlCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.replace(/[)\],.!?]+$/g, "");
  if (!cleaned) {
    return null;
  }
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return cleaned;
}

function isImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const pathname = url.pathname.toLowerCase();
    return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}
