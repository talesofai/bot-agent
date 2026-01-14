import type { SessionElement } from "../types/platform";

export function extractTextFromElements(elements: SessionElement[]): string {
  return elements
    .filter((element) => element.type === "text")
    .map((element) => element.text)
    .join("")
    .trim();
}

export function trimTextElements(elements: SessionElement[]): SessionElement[] {
  let start = 0;
  let end = elements.length;

  while (start < end) {
    const element = elements[start];
    if (element.type !== "text" || hasNonWhitespace(element.text)) {
      break;
    }
    start += 1;
  }

  while (end > start) {
    const element = elements[end - 1];
    if (element.type !== "text" || hasNonWhitespace(element.text)) {
      break;
    }
    end -= 1;
  }

  if (start >= end) {
    return [];
  }

  const result = elements.slice(start, end);
  const first = result[0];
  if (first.type === "text") {
    const trimmed = first.text.trimStart();
    if (trimmed !== first.text) {
      result[0] = { ...first, text: trimmed };
    }
  }

  const lastIndex = result.length - 1;
  const last = result[lastIndex];
  if (last.type === "text") {
    const trimmed = last.text.trimEnd();
    if (trimmed !== last.text) {
      result[lastIndex] = { ...last, text: trimmed };
    }
  }

  return result;
}

function hasNonWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
  }
  return false;
}
