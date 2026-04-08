/**
 * Export CloudKit records to Markdown files with YAML frontmatter.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeNoteContent } from "./decoder.js";
import type { CloudKitRecord, Note } from "./types.js";

/** Convert CloudKit records to Note objects. */
export function recordsToNotes(records: CloudKitRecord[]): Note[] {
  const notes: Note[] = [];

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
    const safeTitle = (title || "untitled")
      .replace(/[<>:"/\\|?*]/g, "_")
      .slice(0, 100);
    const filename = `${dateStr}_${safeTitle}.md`;

    notes.push({ title, body, created, modified: date, filename });
  }

  return notes;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatISO(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Export notes to Markdown files in the given directory. */
export function exportToMarkdown(notes: Note[], outputDir: string): number {
  mkdirSync(outputDir, { recursive: true });

  const usedNames = new Set<string>();
  let saved = 0;

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

    const content = `${frontmatter}\n\n${note.body}`;
    writeFileSync(join(outputDir, filename), content, "utf-8");
    saved++;
  }

  return saved;
}
