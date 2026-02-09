import type { APIEmbed } from "discord.js";

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

const DEFAULT_COVER_FILENAME = "world-cover.png";
const MAX_FILENAME_LENGTH = 64;

export type WorldShowcaseCoverImage = {
  filename: string;
  buffer: Buffer;
};

export type DiscordBufferAttachment = {
  attachment: Buffer;
  name: string;
};

export function buildWorldShowcaseStarterContent(input: {
  opener: string;
  content: string;
}): string {
  return [input.opener, input.content]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export function applyWorldShowcaseCover(input: {
  embeds: APIEmbed[];
  cover?: WorldShowcaseCoverImage | null;
}): { embeds: APIEmbed[]; files: DiscordBufferAttachment[] } {
  const embeds = input.embeds.map((embed) => ({ ...embed }));
  if (!input.cover || input.cover.buffer.byteLength <= 0) {
    return { embeds, files: [] };
  }

  const filename = normalizeCoverFilename(input.cover.filename);
  const nextEmbeds = embeds.length > 0 ? embeds : [{}];
  const first = nextEmbeds[0] ?? {};
  nextEmbeds[0] = {
    ...first,
    image: { url: `attachment://${filename}` },
  };

  return {
    embeds: nextEmbeds,
    files: [{ attachment: input.cover.buffer, name: filename }],
  };
}

function normalizeCoverFilename(raw: string): string {
  const original = raw.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  const ext = extensionFromFilename(original);
  const safeExt = ext && ALLOWED_IMAGE_EXTENSIONS.has(ext) ? ext : ".png";

  const stemRaw = ext ? original.slice(0, -ext.length) : original;
  const safeStem = stemRaw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

  const stem = safeStem || DEFAULT_COVER_FILENAME.slice(0, -safeExt.length);
  const maxStemLength = Math.max(1, MAX_FILENAME_LENGTH - safeExt.length);
  const clampedStem = stem.slice(0, maxStemLength);
  const filename = `${clampedStem}${safeExt}`;

  return filename || DEFAULT_COVER_FILENAME;
}

function extensionFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) {
    return null;
  }
  return filename.slice(dot).toLowerCase();
}
