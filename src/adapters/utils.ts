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
    if (element.type !== "text" || element.text.trim().length > 0) {
      break;
    }
    start += 1;
  }

  while (end > start) {
    const element = elements[end - 1];
    if (element.type !== "text" || element.text.trim().length > 0) {
      break;
    }
    end -= 1;
  }

  const result = elements.slice(start, end);
  if (result.length === 0) {
    return [];
  }

  const first = result[0];
  if (first.type === "text") {
    result[0] = { ...first, text: first.text.trimStart() };
  }

  const lastIndex = result.length - 1;
  const last = result[lastIndex];
  if (last.type === "text") {
    result[lastIndex] = { ...last, text: last.text.trimEnd() };
  }

  return result;
}
