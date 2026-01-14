import type { SessionElement } from "../types/platform";

export function extractTextFromElements(elements: SessionElement[]): string {
  return elements
    .filter((element) => element.type === "text")
    .map((element) => element.text)
    .join("")
    .trim();
}

export function trimTextElements(elements: SessionElement[]): SessionElement[] {
  const result = [...elements];

  let firstIndex = result.findIndex((element) => element.type === "text");
  while (firstIndex !== -1) {
    const firstText = result[firstIndex];
    if (firstText.type !== "text") {
      break;
    }
    const trimmedStart = firstText.text.trimStart();
    if (!trimmedStart) {
      result.splice(firstIndex, 1);
      firstIndex = result.findIndex((element) => element.type === "text");
      continue;
    }
    result[firstIndex] = { ...firstText, text: trimmedStart };
    break;
  }

  let lastIndex = -1;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].type === "text") {
      lastIndex = i;
      break;
    }
  }
  while (lastIndex !== -1) {
    const lastText = result[lastIndex];
    if (lastText.type !== "text") {
      break;
    }
    const trimmedEnd = lastText.text.trimEnd();
    if (!trimmedEnd) {
      result.splice(lastIndex, 1);
      let nextIndex = -1;
      for (let i = lastIndex - 1; i >= 0; i -= 1) {
        if (result[i].type === "text") {
          nextIndex = i;
          break;
        }
      }
      lastIndex = nextIndex;
      continue;
    }
    result[lastIndex] = { ...lastText, text: trimmedEnd };
    break;
  }
  return result;
}
