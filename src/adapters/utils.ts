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

  let firstTextIndex = -1;
  let lastTextIndex = -1;
  const remove = new Set<number>();
  const updatedText = new Map<number, string>();

  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    if (element.type !== "text") {
      continue;
    }
    const trimmedStart = element.text.trimStart();
    if (!trimmedStart) {
      remove.add(i);
      continue;
    }
    firstTextIndex = i;
    updatedText.set(i, trimmedStart);
    break;
  }

  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const element = elements[i];
    if (element.type !== "text") {
      continue;
    }
    const trimmedEnd = element.text.trimEnd();
    if (!trimmedEnd) {
      remove.add(i);
      continue;
    }
    lastTextIndex = i;
    const baseText = updatedText.get(i) ?? element.text;
    updatedText.set(i, baseText.trimEnd());
    break;
  }

  if (firstTextIndex === -1 && lastTextIndex === -1) {
    return elements.filter((element) => element.type !== "text");
  }

  return elements.flatMap((element, index) => {
    if (element.type !== "text") {
      return [element];
    }
    if (remove.has(index)) {
      return [];
    }
    const text = updatedText.get(index);
    if (!text) {
      return [element];
    }
    return [{ ...element, text }];
  });
}
