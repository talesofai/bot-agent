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
  return filtered.map((element, index) => {
    if (element.type !== "text") {
      return element;
    }
    if (index === 0) {
      const text = element.text.trimStart();
      return text === element.text ? element : { ...element, text };
    }
    if (index === filtered.length - 1) {
      const text = element.text.trimEnd();
      return text === element.text ? element : { ...element, text };
    }
    return element;
  });
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
