const AUDIO_TAG_PAIR_PATTERN = /<audio\b[^>]*>[\s\S]*?<\/audio>/gi;
const AUDIO_TAG_SINGLE_PATTERN = /<audio\b[^>]*\/?\s*>/gi;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".oga",
]);

export function normalizeDiscordAudioMarkup(content: string): {
  content: string;
  audioUrls: string[];
} {
  const raw = content.trim();
  if (!raw) {
    return { content: "", audioUrls: [] };
  }

  const audioUrls: string[] = [];

  let normalized = raw.replace(AUDIO_TAG_PAIR_PATTERN, (match) => {
    const src = extractAudioSrcFromTag(match);
    if (src && !audioUrls.includes(src)) {
      audioUrls.push(src);
    }

    const label = extractAudioLabelFromTag(match);
    if (label) {
      return `🎧 ${label}`;
    }
    return "🎧 音频";
  });

  normalized = normalized.replace(AUDIO_TAG_SINGLE_PATTERN, (match) => {
    const src = extractAudioSrcFromTag(match);
    if (src && !audioUrls.includes(src)) {
      audioUrls.push(src);
    }
    return "🎧 音频";
  });

  for (const url of extractAudioUrlsFromText(normalized)) {
    if (!audioUrls.includes(url)) {
      audioUrls.push(url);
    }
  }

  return {
    content: normalized.replace(/\n{3,}/g, "\n\n").trim(),
    audioUrls,
  };
}

function extractAudioSrcFromTag(tag: string): string | null {
  const match = tag.match(/\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  return normalizeUrlCandidate(raw);
}

function extractAudioLabelFromTag(tag: string): string {
  const body = tag
    .replace(/^<audio\b[^>]*>/i, "")
    .replace(/<\/audio>\s*$/i, "");
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAudioUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = normalizeUrlCandidate(match[0]);
    if (!candidate || !isLikelyAudioUrl(candidate)) {
      continue;
    }
    if (urls.includes(candidate)) {
      continue;
    }
    urls.push(candidate);
  }
  return urls;
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

function isLikelyAudioUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return Array.from(AUDIO_EXTENSIONS).some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}
