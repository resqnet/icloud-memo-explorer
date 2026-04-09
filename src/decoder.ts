/**
 * Decode iCloud Notes content from compressed protobuf binary.
 *
 * Apple Notes stores text inside gzip-compressed protobuf with formatting
 * attributes (headings, lists, bold, italic, etc.). This module parses the
 * protobuf wire format, extracts text + attribute runs, and converts them
 * to Markdown.
 */

import { inflateSync, inflateRawSync, gunzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

function tryDecompress(data: Buffer): Buffer | null {
  try {
    return gunzipSync(data);
  } catch {
    /* not gzip */
  }
  try {
    return inflateSync(data);
  } catch {
    /* not zlib */
  }
  try {
    return inflateRawSync(data);
  } catch {
    /* not raw deflate */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire-format reader
// ---------------------------------------------------------------------------

interface ProtoEntry {
  wireType: number;
  varint?: number;
  bytes?: Buffer;
}

type ProtoFields = Map<number, ProtoEntry[]>;

function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  const start = offset;
  while (offset < buf.length) {
    const byte = buf[offset++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, offset];
    shift += 7;
    if (shift > 35) return [result >>> 0, offset]; // safety
  }
  return [0, start]; // failed
}

function parseProto(buf: Buffer): ProtoFields {
  const fields: ProtoFields = new Map();
  let offset = 0;

  while (offset < buf.length) {
    const start = offset;
    const [key, off1] = readVarint(buf, offset);
    if (off1 === start) break;
    offset = off1;

    const fieldNum = key >>> 3;
    const wireType = key & 7;

    if (wireType === 0) {
      // varint
      const [v, off2] = readVarint(buf, offset);
      offset = off2;
      const list = fields.get(fieldNum) ?? [];
      list.push({ wireType, varint: v });
      fields.set(fieldNum, list);
    } else if (wireType === 2) {
      // length-delimited
      const [len, off2] = readVarint(buf, offset);
      offset = off2;
      if (offset + len > buf.length) break;
      const list = fields.get(fieldNum) ?? [];
      list.push({ wireType, bytes: buf.subarray(offset, offset + len) });
      fields.set(fieldNum, list);
      offset += len;
    } else if (wireType === 1) {
      offset += 8; // 64-bit fixed
    } else if (wireType === 5) {
      offset += 4; // 32-bit fixed
    } else {
      break; // unknown wire type
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Apple Notes attribute run types
// ---------------------------------------------------------------------------

interface AttributeRun {
  length: number;
  paragraphStyle?: number;
  indent?: number;
  fontHints?: number; // 1=bold, 2=italic, 3=bold+italic
  strikethrough?: number;
  underline?: number;
  link?: string;
}

/**
 * Paragraph style constants used by Apple Notes.
 */
const PARA = {
  BODY: 0,
  TITLE: 1,
  HEADING: 2,
  SUBHEADING: 3,
  MONO: 4,
  DOT_LIST: 100,
  DASH_LIST: 101,
  NUM_LIST: 102,
  CHECKLIST: 103,
} as const;

// ---------------------------------------------------------------------------
// Protobuf → NoteContent extraction
// ---------------------------------------------------------------------------

interface NoteContent {
  text: string;
  runs: AttributeRun[];
}

/**
 * Check whether a decoded string looks like actual note text
 * (mostly printable characters, CJK, emoji, or U+FFFC image placeholders).
 */
function looksLikeText(s: string): boolean {
  if (s.length < 2) return false;
  let printable = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (
      code >= 0x20 ||
      code === 0x0a ||
      code === 0x09 ||
      code === 0xfffc
    ) {
      printable++;
    }
  }
  return printable / s.length > 0.7;
}

/**
 * Parse attribute runs from repeated protobuf field 5 entries.
 */
function parseAttributeRuns(entries: ProtoEntry[]): AttributeRun[] {
  const runs: AttributeRun[] = [];

  for (const entry of entries) {
    if (!entry.bytes) continue;
    const msg = parseProto(entry.bytes);

    const length = msg.get(1)?.[0]?.varint;
    if (length == null || length === 0) continue;

    const run: AttributeRun = { length };

    // Field 2: ParagraphStyle submessage
    const paraBytes = msg.get(2)?.[0]?.bytes;
    if (paraBytes) {
      const para = parseProto(paraBytes);
      run.paragraphStyle = para.get(1)?.[0]?.varint;
      run.indent = para.get(4)?.[0]?.varint;
    }

    // Field 5: Font submessage
    const fontBytes = msg.get(5)?.[0]?.bytes;
    if (fontBytes) {
      const font = parseProto(fontBytes);
      run.fontHints = font.get(3)?.[0]?.varint;
    }

    // Field 3: link URL (length-delimited string)
    const linkBytes = msg.get(3)?.[0]?.bytes;
    if (linkBytes) {
      try {
        const url = linkBytes.toString("utf-8");
        if (url.startsWith("http://") || url.startsWith("https://")) {
          run.link = url;
        }
      } catch {
        /* ignore */
      }
    }

    // Field 6: strikethrough
    run.strikethrough = msg.get(6)?.[0]?.varint;

    // Field 7: underline
    run.underline = msg.get(7)?.[0]?.varint;

    runs.push(run);
  }

  return runs;
}

/**
 * Recursively search the protobuf tree for a message containing
 * text (field 2 string) and attribute runs (field 5 repeated messages).
 *
 * Apple Notes nests the note body at varying depths depending on iOS version:
 *   root → 2 → 3 → {text=2, runs=5}  (common)
 *   root → 2 → {text=2, runs=5}       (some versions)
 */
function findNoteContent(buf: Buffer, maxDepth = 6): NoteContent | null {
  if (maxDepth <= 0 || buf.length < 4) return null;

  const fields = parseProto(buf);

  // Check if this level has field 2 (string) + field 5 (runs)
  const f2 = fields.get(2)?.[0];
  const f5 = fields.get(5);

  if (f2?.bytes && f5 && f5.length > 0) {
    const text = f2.bytes.toString("utf-8");
    if (looksLikeText(text)) {
      const runs = parseAttributeRuns(f5);
      // Validate: total run lengths should roughly match text length
      const totalLen = runs.reduce((s, r) => s + r.length, 0);
      if (runs.length > 0 && Math.abs(totalLen - [...text].length) <= 2) {
        return { text, runs };
      }
    }
  }

  // Recurse into length-delimited fields (potential submessages)
  for (const [, entries] of fields) {
    for (const entry of entries) {
      if (entry.bytes && entry.bytes.length > 8) {
        const result = findNoteContent(entry.bytes, maxDepth - 1);
        if (result) return result;
      }
    }
  }

  return null;
}

/**
 * Extract just the text string from the protobuf (no formatting).
 * Used for titles where we don't need Markdown.
 */
function findPlainText(buf: Buffer, maxDepth = 6): string | null {
  if (maxDepth <= 0 || buf.length < 4) return null;

  const fields = parseProto(buf);

  // Check field 2 for a text string
  const f2 = fields.get(2)?.[0];
  if (f2?.bytes) {
    const text = f2.bytes.toString("utf-8");
    if (looksLikeText(text)) return text;
  }

  // Recurse
  for (const [, entries] of fields) {
    for (const entry of entries) {
      if (entry.bytes && entry.bytes.length > 4) {
        const result = findPlainText(entry.bytes, maxDepth - 1);
        if (result) return result;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Markdown conversion
// ---------------------------------------------------------------------------

/**
 * Wrap inline text with a Markdown marker (**, *, ~~, etc.),
 * keeping leading/trailing whitespace outside the markers.
 */
function wrapInline(text: string, marker: string): string {
  const m = text.match(/^(\s*)(.*?)(\s*)$/s);
  if (!m || !m[2]) return text;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

/**
 * Convert NoteContent (text + attribute runs) into Markdown.
 */
function toMarkdown(content: NoteContent): string {
  const { text, runs } = content;
  if (runs.length === 0) return text;

  // Spread characters — we need to work in terms of Unicode code points
  // since run lengths count code points, not UTF-16 code units.
  const chars = [...text];

  // Build per-character run index
  const charRun: AttributeRun[] = new Array(chars.length);
  let pos = 0;
  for (const run of runs) {
    for (let i = 0; i < run.length && pos < chars.length; i++, pos++) {
      charRun[pos] = run;
    }
  }
  // Fill any remaining with empty run
  const emptyRun: AttributeRun = { length: 0 };
  for (; pos < chars.length; pos++) {
    charRun[pos] = emptyRun;
  }

  // Split into lines and process each
  const lines: string[] = [];
  let lineStart = 0;

  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || chars[i] === "\n") {
      const lineChars = chars.slice(lineStart, i);
      const lineRuns = charRun.slice(lineStart, i);

      // Paragraph style comes from the newline char's run (Apple Notes convention)
      const nlRun = i < chars.length ? charRun[i] : undefined;
      let paraStyle = nlRun?.paragraphStyle ?? 0;
      let indent = nlRun?.indent ?? 0;

      // Fallback: check any char in the line for paragraph style
      if (paraStyle === 0) {
        for (const r of lineRuns) {
          if (r?.paragraphStyle) {
            paraStyle = r.paragraphStyle;
            indent = r.indent ?? 0;
            break;
          }
        }
      }

      // Build inline-formatted text
      let formatted = "";
      let j = 0;
      while (j < lineChars.length) {
        // Group consecutive characters with the same inline formatting
        const curRun = lineRuns[j]!;
        let k = j + 1;
        while (
          k < lineChars.length &&
          lineRuns[k]?.fontHints === curRun.fontHints &&
          lineRuns[k]?.strikethrough === curRun.strikethrough &&
          lineRuns[k]?.link === curRun.link
        ) {
          k++;
        }

        let segment = lineChars.slice(j, k).join("");

        // Apply inline styles (skip for monospaced paragraphs)
        if (paraStyle !== PARA.MONO) {
          const hints = curRun.fontHints ?? 0;
          if (hints === 3) segment = wrapInline(segment, "***");
          else if (hints === 1) segment = wrapInline(segment, "**");
          else if (hints === 2) segment = wrapInline(segment, "*");

          if (curRun.strikethrough) segment = wrapInline(segment, "~~");

          if (curRun.link && segment.trim()) {
            segment = `[${segment.trim()}](${curRun.link})`;
          }
        }

        formatted += segment;
        j = k;
      }

      // Apply paragraph-level formatting
      const indentPrefix = "  ".repeat(indent);

      switch (paraStyle) {
        case PARA.TITLE:
          formatted = `# ${formatted}`;
          break;
        case PARA.HEADING:
          formatted = `## ${formatted}`;
          break;
        case PARA.SUBHEADING:
          formatted = `### ${formatted}`;
          break;
        case PARA.MONO:
          formatted = `    ${formatted}`;
          break;
        case PARA.DOT_LIST:
          formatted = `${indentPrefix}- ${formatted}`;
          break;
        case PARA.DASH_LIST:
          formatted = `${indentPrefix}- ${formatted}`;
          break;
        case PARA.NUM_LIST:
          formatted = `${indentPrefix}1. ${formatted}`;
          break;
        case PARA.CHECKLIST:
          formatted = `${indentPrefix}- [ ] ${formatted}`;
          break;
        default:
          break;
      }

      lines.push(formatted);
      lineStart = i + 1;
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fallback: extract text from binary (legacy)
// ---------------------------------------------------------------------------

/**
 * Filter out protobuf artifacts: UUIDs, short hex prefixes,
 * internal object references (e.g. "$XXXXXXXX-..."), etc.
 */
function isProtobufArtifact(s: string): boolean {
  const trimmed = s.trim();
  // UUID pattern (with or without $ prefix)
  if (/^\$?[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(trimmed))
    return true;
  // Very short strings (< 4 real chars) are likely field tags
  if (trimmed.length < 4) return true;
  // Strings that are mostly hex/punctuation with no real words
  const alphaNum = trimmed.replace(/[^a-zA-Z\u3000-\u9fff\uff00-\uffef]/g, "");
  if (alphaNum.length < trimmed.length * 0.3 && trimmed.length < 60)
    return true;
  return false;
}

function extractTextFromBinary(data: Buffer): string {
  const runs: string[] = [];
  const current: number[] = [];

  for (const b of data) {
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
          if (text.length >= 2) runs.push(text);
        } catch {
          /* invalid utf-8 */
        }
        current.length = 0;
      }
    }
  }

  if (current.length > 0) {
    try {
      const text = Buffer.from(current).toString("utf-8");
      if (text.length >= 2) runs.push(text);
    } catch {
      /* invalid utf-8 */
    }
  }

  // Filter out protobuf artifacts, then return the longest remaining run
  const filtered = runs.filter((r) => !isProtobufArtifact(r));

  return filtered.length > 0
    ? filtered.reduce((a, b) => (a.length >= b.length ? a : b))
    : "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode note content as plain text (used for titles).
 */
export function decodeNoteContent(base64Data: string): string {
  const raw = Buffer.from(base64Data, "base64");
  const decompressed = tryDecompress(raw);
  const data = decompressed ?? raw;

  // Try protobuf-aware extraction (plain text only)
  const protoText = findPlainText(data);
  if (protoText) return protoText;

  // Fallback
  const text = extractTextFromBinary(data);
  if (text) return text;

  return data.toString("utf-8").replace(/\uFFFD/g, "");
}

/**
 * Decode note body with Markdown formatting from attribute runs.
 * Falls back to plain text extraction if protobuf parsing fails.
 */
export function decodeNoteBodyAsMarkdown(base64Data: string): string {
  const raw = Buffer.from(base64Data, "base64");
  const decompressed = tryDecompress(raw);
  const data = decompressed ?? raw;

  // Try protobuf-aware decoding with attribute runs → Markdown
  const content = findNoteContent(data);
  if (content) return toMarkdown(content);

  // Fallback: plain text extraction
  const text = extractTextFromBinary(data);
  if (text) return text;

  return data.toString("utf-8").replace(/\uFFFD/g, "");
}
