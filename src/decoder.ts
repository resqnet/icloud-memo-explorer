/**
 * Decode iCloud Notes content from compressed protobuf binary.
 *
 * Apple Notes stores text inside gzip-compressed protobuf.
 * We decompress and extract readable UTF-8 text runs.
 */

import { inflateSync, inflateRawSync, gunzipSync } from "node:zlib";

/** Try multiple decompression strategies. */
function tryDecompress(data: Buffer): Buffer | null {
  // gzip
  try {
    return gunzipSync(data);
  } catch {
    // not gzip
  }
  // zlib (with header)
  try {
    return inflateSync(data);
  } catch {
    // not zlib
  }
  // raw deflate (no header)
  try {
    return inflateRawSync(data);
  } catch {
    // not raw deflate
  }
  return null;
}

/**
 * Extract the longest readable UTF-8 text run from binary data.
 *
 * Scans byte-by-byte, collecting sequences of valid UTF-8 characters
 * (including CJK) and returns the longest continuous run.
 */
function extractTextFromBinary(data: Buffer): string {
  const runs: string[] = [];
  const current: number[] = [];

  for (const b of data) {
    // Accept printable ASCII, UTF-8 multi-byte start/continuation, newline, tab
    if (
      (b >= 0x20 && b < 0x7f) ||
      b >= 0xc0 ||
      (b >= 0x80 && b <= 0xbf && current.length > 0) ||
      b === 0x0a ||
      b === 0x09
    ) {
      current.push(b);
    } else {
      if (current.length > 0) {
        try {
          const text = Buffer.from(current).toString("utf-8");
          if (text.length >= 2) {
            runs.push(text);
          }
        } catch {
          // invalid utf-8
        }
        current.length = 0;
      }
    }
  }

  if (current.length > 0) {
    try {
      const text = Buffer.from(current).toString("utf-8");
      if (text.length >= 2) {
        runs.push(text);
      }
    } catch {
      // invalid utf-8
    }
  }

  if (runs.length === 0) return "";

  // Return the longest run
  return runs.reduce((a, b) => (a.length >= b.length ? a : b));
}

/** Decode note content from base64-encoded compressed data. */
export function decodeNoteContent(base64Data: string): string {
  const raw = Buffer.from(base64Data, "base64");
  const decompressed = tryDecompress(raw);
  const data = decompressed ?? raw;

  const text = extractTextFromBinary(data);
  if (text) return text;

  // Last resort: plain UTF-8
  return data.toString("utf-8").replace(/\uFFFD/g, "");
}
