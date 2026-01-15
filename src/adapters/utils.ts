import type { SessionElement } from "../types/platform";

export function extractTextFromElements(elements: SessionElement[]): string {
  return elements
    .filter((element) => element.type === "text")
    .map((element) => element.text)
    .join("")
    .trim();
}

export function appendTextElement(
  elements: SessionElement[],
  text: string,
): void {
  if (!hasNonWhitespace(text)) {
    return;
  }
  elements.push({ type: "text", text });
}

export function trimTextElements(elements: SessionElement[]): SessionElement[] {
  const filtered = elements.filter(
    (element) => element.type !== "text" || hasNonWhitespace(element.text),
  );
  if (filtered.length === 0) {
    return [];
  }
  const result = [...filtered];

  let firstTextIndex = -1;
  for (let i = 0; i < result.length; i += 1) {
    if (result[i].type === "text") {
      firstTextIndex = i;
      break;
    }
  }
  if (firstTextIndex >= 0) {
    const first = result[firstTextIndex] as Extract<
      SessionElement,
      { type: "text" }
    >;
    const text = first.text.trimStart();
    if (text !== first.text) {
      result[firstTextIndex] = { ...first, text };
    }
  }

  let lastTextIndex = -1;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].type === "text") {
      lastTextIndex = i;
      break;
    }
  }
  if (lastTextIndex >= 0) {
    const last = result[lastTextIndex] as Extract<
      SessionElement,
      { type: "text" }
    >;
    const text = last.text.trimEnd();
    if (text !== last.text) {
      result[lastTextIndex] = { ...last, text };
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
