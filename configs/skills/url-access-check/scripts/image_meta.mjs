#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import fs from "node:fs";
import process from "node:process";

function readBuffer(path) {
  return fs.readFileSync(path);
}

function parsePng(buffer) {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8);
  const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!signature.equals(expected)) return null;
  const ihdrType = buffer.subarray(12, 16).toString("ascii");
  if (ihdrType !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { format: "png", width, height };
}

function parseGif(buffer) {
  if (buffer.length < 10) return null;
  const header = buffer.subarray(0, 6).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return { format: "gif", width, height };
}

function parseBmp(buffer) {
  if (buffer.length < 26) return null;
  if (buffer.subarray(0, 2).toString("ascii") !== "BM") return null;
  const width = buffer.readInt32LE(18);
  const height = Math.abs(buffer.readInt32LE(22));
  if (width <= 0 || height <= 0) return null;
  return { format: "bmp", width, height };
}

function parseWebp(buffer) {
  if (buffer.length < 16) return null;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (buffer.subarray(8, 12).toString("ascii") !== "WEBP") return null;

  const vp8xIndex = buffer.indexOf("VP8X");
  if (vp8xIndex !== -1 && vp8xIndex + 20 <= buffer.length) {
    const widthMinus1 =
      buffer[vp8xIndex + 12] |
      (buffer[vp8xIndex + 13] << 8) |
      (buffer[vp8xIndex + 14] << 16);
    const heightMinus1 =
      buffer[vp8xIndex + 15] |
      (buffer[vp8xIndex + 16] << 8) |
      (buffer[vp8xIndex + 17] << 16);
    return {
      format: "webp",
      width: widthMinus1 + 1,
      height: heightMinus1 + 1,
    };
  }

  const vp8Index = buffer.indexOf("VP8 ");
  if (vp8Index !== -1) {
    const payloadStart = vp8Index + 8;
    const signatureIndex = buffer.indexOf(
      Buffer.from([0x9d, 0x01, 0x2a]),
      payloadStart,
    );
    if (signatureIndex !== -1 && signatureIndex + 7 <= buffer.length) {
      const width = buffer.readUInt16LE(signatureIndex + 3) & 0x3fff;
      const height = buffer.readUInt16LE(signatureIndex + 5) & 0x3fff;
      if (width > 0 && height > 0) {
        return { format: "webp", width, height };
      }
    }
  }

  const vp8lIndex = buffer.indexOf("VP8L");
  if (vp8lIndex !== -1 && vp8lIndex + 16 <= buffer.length) {
    const payloadStart = vp8lIndex + 8;
    if (buffer[payloadStart] === 0x2f && payloadStart + 5 <= buffer.length) {
      const b0 = buffer[payloadStart + 1];
      const b1 = buffer[payloadStart + 2];
      const b2 = buffer[payloadStart + 3];
      const b3 = buffer[payloadStart + 4];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      if (width > 0 && height > 0) {
        return { format: "webp", width, height };
      }
    }
  }

  return null;
}

function parseJpeg(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (offset + 2 > buffer.length) return null;

    const length = buffer.readUInt16BE(offset);
    if (length < 2) return null;
    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    if (segmentEnd > buffer.length) return null;

    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (segmentStart + 5 > buffer.length) return null;
      const height = buffer.readUInt16BE(segmentStart + 1);
      const width = buffer.readUInt16BE(segmentStart + 3);
      if (width > 0 && height > 0) {
        return { format: "jpeg", width, height };
      }
      return null;
    }

    offset = segmentEnd;
  }

  return null;
}

function parseImageMeta(buffer) {
  return (
    parsePng(buffer) ??
    parseGif(buffer) ??
    parseWebp(buffer) ??
    parseJpeg(buffer) ??
    parseBmp(buffer)
  );
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write("usage: image_meta.mjs <file>\n");
    process.exit(2);
  }
  const buffer = readBuffer(filePath);
  const meta = parseImageMeta(buffer);
  if (!meta) {
    process.exit(1);
  }
  process.stdout.write(
    `format=${meta.format} width=${meta.width} height=${meta.height}\n`,
  );
}

main();
