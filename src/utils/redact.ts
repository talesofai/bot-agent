import type { SessionElement } from "../types/platform";

export function redactSensitiveText(input: string): string {
  if (!input) {
    return input;
  }
  let out = input;

  // JWT (three base64url-ish segments)
  out = out.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    (token) => maskToken(token),
  );

  // OpenAI-style keys
  out = out.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, (token) => maskToken(token));

  // Bearer <token>
  out = out.replace(/\bBearer\s+([A-Za-z0-9._-]{10,})\b/gi, (_m, token) => {
    return `Bearer ${maskToken(String(token))}`;
  });

  // key=value in text
  out = out.replace(
    /\b(x-token|token|api[_-]?key|apikey|secret|password)\s*[:=]\s*([^\s"'`]{6,})/gi,
    (_m, key, value) => `${String(key)}: ${maskToken(String(value))}`,
  );

  // token-like query params
  out = out.replace(
    /([?&](?:x-token|token|api[_-]?key|apikey|secret|password)=)([^&\s]+)/gi,
    (_m, prefix, value) => `${String(prefix)}${maskToken(String(value))}`,
  );

  return out;
}

export function redactSensitiveElements(
  elements: ReadonlyArray<SessionElement>,
): SessionElement[] {
  if (elements.length === 0) {
    return [];
  }
  let changed = false;
  const next = elements.map((element) => {
    if (element.type !== "text") {
      return element;
    }
    const redacted = redactSensitiveText(element.text);
    if (redacted === element.text) {
      return element;
    }
    changed = true;
    return { ...element, text: redacted };
  });
  return changed ? next : [...elements];
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 12) {
    return "***";
  }
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  return `${head}***${tail}`;
}
