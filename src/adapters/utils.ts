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

  const result = elements.map((element) => ({ ...element }));

  while (result.length > 0) {
    const first = result[0];
    if (first.type !== "text") {
      break;
    }
    if (first.text.trim()) {
      break;
    }
    result.shift();
  }

  if (result[0]?.type === "text") {
    result[0] = { ...result[0], text: result[0].text.trimStart() };
  }

  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last.type !== "text") {
      break;
    }
    if (last.text.trim()) {
      break;
    }
    result.pop();
  }

  if (result[result.length - 1]?.type === "text") {
    const lastIndex = result.length - 1;
    result[lastIndex] = {
      ...result[lastIndex],
      text: result[lastIndex].text.trimEnd(),
    };
  }

  return result;
}
