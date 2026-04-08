/**
 * Local browser-based viewer for exported Markdown notes.
 * Serves a single-page app with search and note browsing.
 */

import express from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { Marked } from "marked";

interface NoteMeta {
  slug: string;
  title: string;
  created: string;
  modified: string;
  preview: string;
}

interface NoteDetail extends NoteMeta {
  bodyMd: string;
  bodyHtml: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!content.startsWith("---")) return { meta, body: content };

  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta, body: content };

  const front = content.slice(4, end);
  for (const line of front.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Remove JSON quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    meta[key] = value;
  }

  const body = content.slice(end + 4).trim();
  return { meta, body };
}

function loadNotes(dir: string): { metas: NoteMeta[]; details: Map<string, NoteDetail> } {
  const files = readdirSync(dir).filter((f) => extname(f) === ".md").sort().reverse();
  const marked = new Marked();
  const metas: NoteMeta[] = [];
  const details = new Map<string, NoteDetail>();

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    const { meta, body } = parseFrontmatter(content);
    const slug = file.replace(/\.md$/, "");
    const title = meta.title || slug;
    const preview = body.replace(/\n/g, " ").slice(0, 150);

    const noteMeta: NoteMeta = {
      slug,
      title,
      created: meta.created || "",
      modified: meta.modified || "",
      preview,
    };
    metas.push(noteMeta);

    details.set(slug, {
      ...noteMeta,
      bodyMd: body,
      bodyHtml: marked.parse(body) as string,
    });
  }

  return { metas, details };
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iCloud Memo Explorer</title>
<style>
  :root {
    --bg: #0f0f0f;
    --surface: #1a1a1a;
    --surface2: #252525;
    --border: #333;
    --text: #e0e0e0;
    --text2: #888;
    --accent: #6eb6ff;
    --accent2: #4a9eff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  .sidebar {
    width: 360px;
    min-width: 300px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-header h1 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
    color: var(--accent);
  }
  .search-box {
    width: 100%;
    padding: 8px 12px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    outline: none;
  }
  .search-box:focus { border-color: var(--accent); }
  .note-count {
    font-size: 12px;
    color: var(--text2);
    margin-top: 8px;
  }
  .note-list {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .note-item {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s;
  }
  .note-item:hover { background: var(--surface2); }
  .note-item.active { background: var(--accent2); color: #fff; }
  .note-item.active .note-date,
  .note-item.active .note-preview { color: rgba(255,255,255,0.7); }
  .note-title {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note-date {
    font-size: 11px;
    color: var(--text2);
    margin-bottom: 4px;
  }
  .note-preview {
    font-size: 12px;
    color: var(--text2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 40px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .content.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text2);
    font-size: 18px;
  }
  .content h1 { font-size: 28px; margin-bottom: 8px; }
  .content .meta { font-size: 13px; color: var(--text2); margin-bottom: 24px; }
  .content .body {
    font-size: 15px;
    line-height: 1.7;
    max-width: 720px;
  }
  .content .body h1, .content .body h2, .content .body h3 {
    margin-top: 24px;
    margin-bottom: 12px;
  }
  .content .body p { margin-bottom: 12px; }
  .content .body pre {
    background: var(--surface);
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
    margin-bottom: 12px;
  }
  .content .body code {
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
  }
  .content .body pre code { background: none; padding: 0; }
  .content .body ul, .content .body ol { padding-left: 24px; margin-bottom: 12px; }
  .content .body blockquote {
    border-left: 3px solid var(--accent);
    padding-left: 16px;
    color: var(--text2);
    margin-bottom: 12px;
  }
  .content .body a { color: var(--accent); }
  .content .body img { max-width: 100%; border-radius: 8px; }
  @media (max-width: 768px) {
    body { flex-direction: column; }
    .sidebar { width: 100%; height: 40vh; min-width: unset; }
    .content { padding: 20px; }
  }
</style>
</head>
<body>
<div class="sidebar">
  <div class="sidebar-header">
    <h1>iCloud Memo Explorer</h1>
    <input type="text" class="search-box" placeholder="Search notes..." id="search">
    <div class="note-count" id="count"></div>
  </div>
  <div class="note-list" id="list"></div>
</div>
<div class="content empty" id="content">
  Select a note to view
</div>
<script>
let notes = [];
let currentSlug = null;

async function init() {
  const resp = await fetch('/api/notes');
  notes = await resp.json();
  renderList(notes);
  document.getElementById('count').textContent = notes.length + ' notes';
}

function renderList(items) {
  const list = document.getElementById('list');
  list.innerHTML = items.map(n =>
    '<div class="note-item' + (n.slug === currentSlug ? ' active' : '') + '" data-slug="' + n.slug + '">' +
      '<div class="note-title">' + esc(n.title) + '</div>' +
      '<div class="note-date">' + formatDate(n.modified || n.created) + '</div>' +
      '<div class="note-preview">' + esc(n.preview) + '</div>' +
    '</div>'
  ).join('');

  list.querySelectorAll('.note-item').forEach(el => {
    el.addEventListener('click', () => loadNote(el.dataset.slug));
  });
}

async function loadNote(slug) {
  currentSlug = slug;
  const resp = await fetch('/api/notes/' + encodeURIComponent(slug));
  const note = await resp.json();
  const content = document.getElementById('content');
  content.className = 'content';
  content.innerHTML =
    '<h1>' + esc(note.title) + '</h1>' +
    '<div class="meta">Created: ' + formatDate(note.created) + ' | Modified: ' + formatDate(note.modified) + '</div>' +
    '<div class="body">' + note.bodyHtml + '</div>';

  // Re-render list to update active state
  const filtered = getFilteredNotes();
  renderList(filtered);
}

function getFilteredNotes() {
  const q = document.getElementById('search').value.toLowerCase();
  if (!q) return notes;
  return notes.filter(n =>
    n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q)
  );
}

document.getElementById('search').addEventListener('input', () => {
  const filtered = getFilteredNotes();
  renderList(filtered);
  document.getElementById('count').textContent = filtered.length + ' / ' + notes.length + ' notes';
});

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { return iso; }
}

init();
</script>
</body>
</html>`;

export function startViewer(notesDir: string, port: number = 3000): Promise<void> {
  const { metas, details } = loadNotes(notesDir);
  const app = express();

  app.get("/", (_req, res) => {
    res.type("html").send(HTML_TEMPLATE);
  });

  app.get("/api/notes", (_req, res) => {
    res.json(metas);
  });

  app.get("/api/notes/:slug", (req, res) => {
    const note = details.get(req.params.slug);
    if (!note) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(note);
  });

  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`\n  iCloud Memo Explorer is running!`);
      console.log(`  Open http://localhost:${port} in your browser.\n`);
      console.log(`  Loaded ${metas.length} notes from ${notesDir}`);
      console.log(`  Press Ctrl+C to stop.\n`);
      resolve();
    });
  });
}
