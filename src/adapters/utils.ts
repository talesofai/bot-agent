import type { SessionElement } from "../types/platform";

export function extractTextFromElements(elements: SessionElement[]): string {
  return elements
    .filter((element) => element.type === "text")
    .map((element) => element.text)
    .join("")
    .trim();
}

export function trimTextElements(elements: SessionElement[]): SessionElement[] {
  if (elements.length === 0) {
    return [];
  }

  const trimmedLeading: SessionElement[] = [];
  let started = false;
  for (const element of elements) {
    if (element.type !== "text") {
      trimmedLeading.push(element);
      continue;
    }
    if (!started) {
      const text = element.text.trimStart();
      if (!text) {
        continue;
      }
      trimmedLeading.push({ ...element, text });
      started = true;
      continue;
    }
    trimmedLeading.push(element);
  }

  const trimmedTrailing: SessionElement[] = [];
  let ended = false;
  for (let i = trimmedLeading.length - 1; i >= 0; i -= 1) {
    const element = trimmedLeading[i];
    if (element.type !== "text") {
      trimmedTrailing.push(element);
      continue;
    }
    if (!ended) {
      const text = element.text.trimEnd();
      if (!text) {
        continue;
      }
      trimmedTrailing.push({ ...element, text });
      ended = true;
      continue;
    }
    trimmedTrailing.push(element);
  }

  trimmedTrailing.reverse();
  return trimmedTrailing;
}
