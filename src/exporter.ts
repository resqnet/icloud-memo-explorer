/**
 * Export CloudKit records to Markdown files with YAML frontmatter.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeNoteContent } from "./decoder.js";
import type { CloudKitRecord, Note, NoteImage } from "./types.js";

/** Image download descriptor returned by exportToMarkdown. */
export interface PendingImageDownload {
  url: string;
  filepath: string;
}

/**
 * Determine file extension from a UTI string such as "public.jpeg" or "public.png".
 */
function utiToExtension(uti: string): string {
  const lower = uti.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("png")) return ".png";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("tiff") || lower.includes("tif")) return ".tiff";
  if (lower.includes("heic") || lower.includes("heif")) return ".heic";
  if (lower.includes("webp")) return ".webp";
  // fallback
  return ".jpg";
}

/**
 * Check whether a UTI represents an image type.
 */
function isImageUTI(uti: string): boolean {
  const lower = uti.toLowerCase();
  return (
    lower.includes("image") ||
    lower.includes("jpeg") ||
    lower.includes("jpg") ||
    lower.includes("png") ||
    lower.includes("gif") ||
    lower.includes("tiff") ||
    lower.includes("heic") ||
    lower.includes("heif") ||
    lower.includes("webp")
  );
}

/**
 * Build a map of noteRecordName -> NoteImage[] from Attachment and Media records.
 */
function buildAttachmentMap(
  records: CloudKitRecord[],
): Map<string, NoteImage[]> {
  // Build Media record map: mediaRecordName -> downloadURL
  const mediaMap = new Map<string, string>();
  for (const record of records) {
    if (record.recordType !== "Media") continue;
    const fields = record.fields ?? {};
    const asset = fields.Asset?.value as
      | { downloadURL?: string }
      | undefined;
    if (asset?.downloadURL) {
      mediaMap.set(record.recordName, asset.downloadURL);
    }
  }

  // Build attachment map: noteRecordName -> NoteImage[]
  const attachmentMap = new Map<string, NoteImage[]>();

  for (const record of records) {
    if (record.recordType !== "Attachment") continue;

    const fields = record.fields ?? {};

    // Skip deleted attachments
    if (fields.Deleted?.value) continue;

    // Check UTI for image type
    const uti = (fields.UTI?.value as string) ?? "";
    if (!isImageUTI(uti)) continue;

    // Get parent note recordName
    const noteRef = fields.Note?.value as
      | { recordName?: string }
      | undefined;
    if (!noteRef?.recordName) continue;
    const noteRecordName = noteRef.recordName;

    // Determine download URL: prefer largest PreviewImage, fall back to Media
    let downloadUrl = "";

    const previewImages = fields.PreviewImages?.value as
      | Array<{ downloadURL?: string; size?: number; fileChecksum?: string }>
      | undefined;
    if (previewImages && previewImages.length > 0) {
      // Pick the one with the largest size
      let best = previewImages[0]!;
      for (const img of previewImages) {
        if ((img.size ?? 0) > (best.size ?? 0)) {
          best = img;
        }
      }
      downloadUrl = best.downloadURL ?? "";
    }

    // Fall back to Media record
    if (!downloadUrl) {
      const mediaRef = fields.Media?.value as
        | { recordName?: string }
        | undefined;
      if (mediaRef?.recordName) {
        downloadUrl = mediaMap.get(mediaRef.recordName) ?? "";
      }
    }

    if (!downloadUrl) continue;

    // Determine filename
    const ext = utiToExtension(uti);
    const filename = `${record.recordName}${ext}`;

    // Dimensions (optional)
    const width = fields.Width?.value as number | undefined;
    const height = fields.Height?.value as number | undefined;

    const image: NoteImage = { filename, url: downloadUrl };
    if (width != null) image.width = width;
    if (height != null) image.height = height;

    const list = attachmentMap.get(noteRecordName) ?? [];
    list.push(image);
    attachmentMap.set(noteRecordName, list);
  }

  return attachmentMap;
}

/** Convert CloudKit records to Note objects. */
export function recordsToNotes(records: CloudKitRecord[]): Note[] {
  const notes: Note[] = [];
  const attachmentMap = buildAttachmentMap(records);

  for (const record of records) {
    if (record.recordType !== "Note") continue;

    const fields = record.fields ?? {};

    // Skip deleted notes
    const deleted = fields.Deleted?.value;
    if (deleted) continue;

    // Date
    const ts = (record.modified?.timestamp ?? record.created?.timestamp ?? 0) as number;
    const date = ts ? new Date(ts) : new Date(0);
    const createdTs = (record.created?.timestamp ?? ts) as number;
    const created = createdTs ? new Date(createdTs) : date;

    // Title
    let title = "";
    const titleField = fields.TitleEncrypted?.value as string | undefined;
    if (titleField) {
      try {
        title = decodeNoteContent(titleField).trim();
      } catch {
        // skip
      }
    }

    // Body
    let body = "";
    const textField = fields.TextDataEncrypted?.value as string | undefined;
    if (textField) {
      try {
        body = decodeNoteContent(textField).trim();
      } catch {
        // skip
      }
    }

    if (!body) {
      const snippetField = fields.SnippetEncrypted?.value as string | undefined;
      if (snippetField) {
        try {
          body = decodeNoteContent(snippetField).trim();
        } catch {
          // skip
        }
      }
    }

    if (!title && !body) continue;

    // Filename
    const dateStr = formatDate(date);
    const safeTitle = sanitizeFilename(title || "untitled")
      .slice(0, 100);
    const filename = `${dateStr}_${safeTitle}.md`;

    // Images from attachments
    const images = attachmentMap.get(record.recordName) ?? [];

    notes.push({ title, body, created, modified: date, filename, images });
  }

  return notes;
}

/**
 * Sanitize a string for use as a filename on Windows, macOS, and Linux.
 * - Removes control characters (0x00-0x1F, 0x7F) including tab, newline, etc.
 * - Replaces characters forbidden by Windows: < > : " / \ | ? *
 * - Replaces full-width variants commonly found in CJK text that may cause issues
 * - Strips trailing dots and spaces (Windows rejects these)
 * - Falls back to "untitled" if the result is empty or a Windows reserved name
 */
function sanitizeFilename(name: string): string {
  let safe = name
    // Remove control characters (tab, newline, etc.)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    // Replace characters invalid on Windows (and problematic elsewhere)
    .replace(/[<>:"/\\|?*]/g, "_")
    // Collapse multiple underscores / spaces
    .replace(/_{2,}/g, "_")
    // Trim leading/trailing whitespace, dots, and underscores
    .replace(/^[\s._]+|[\s._]+$/g, "");

  // Guard against Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(safe)) {
    safe = `_${safe}`;
  }

  return safe || "untitled";
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatISO(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Export notes to Markdown files in the given directory. Returns pending image downloads. */
export function exportToMarkdown(
  notes: Note[],
  outputDir: string,
): { saved: number; pendingImages: PendingImageDownload[] } {
  mkdirSync(outputDir, { recursive: true });

  // Create images subdirectory
  const imagesDir = join(outputDir, "images");
  mkdirSync(imagesDir, { recursive: true });

  const usedNames = new Set<string>();
  let saved = 0;
  const pendingImages: PendingImageDownload[] = [];

  for (const note of notes) {
    let filename = note.filename;

    // Deduplicate filenames
    let base = filename.replace(/\.md$/, "");
    let counter = 1;
    while (usedNames.has(filename)) {
      filename = `${base}_${counter}.md`;
      counter++;
    }
    usedNames.add(filename);

    const frontmatter = [
      "---",
      `title: ${JSON.stringify(note.title || "Untitled")}`,
      `created: ${formatISO(note.created)}`,
      `modified: ${formatISO(note.modified)}`,
      "---",
    ].join("\n");

    // Append image references to the body
    let bodyWithImages = note.body;
    for (const image of note.images) {
      bodyWithImages += `\n\n![image](./images/${image.filename})`;
      pendingImages.push({
        url: image.url,
        filepath: join(imagesDir, image.filename),
      });
    }

    const content = `${frontmatter}\n\n${bodyWithImages}`;
    writeFileSync(join(outputDir, filename), content, "utf-8");
    saved++;
  }

  return { saved, pendingImages };
}

/**
 * Download images from the given URLs and save to local filepaths.
 * Skips files that already exist. Returns the count of newly downloaded images.
 */
export async function downloadImages(
  images: PendingImageDownload[],
  onProgress?: (downloaded: number, total: number) => void,
): Promise<number> {
  let downloaded = 0;
  const total = images.length;

  for (const image of images) {
    // Skip if file already exists
    if (existsSync(image.filepath)) {
      downloaded++;
      onProgress?.(downloaded, total);
      continue;
    }

    try {
      const resp = await fetch(image.url);
      if (!resp.ok) {
        console.error(
          `  Warning: Failed to download image (HTTP ${resp.status}): ${image.filepath}`,
        );
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      await writeFile(image.filepath, buffer);
      downloaded++;
      onProgress?.(downloaded, total);
    } catch (err) {
      console.error(
        `  Warning: Failed to download image: ${image.filepath} - ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return downloaded;
}
