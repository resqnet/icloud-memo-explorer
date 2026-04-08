#!/usr/bin/env node

/**
 * icloud-memo-explorer CLI
 *
 * Usage:
 *   npx icloud-memo-explorer                          # Interactive: fetch + view
 *   npx icloud-memo-explorer --apple-id user@example.com
 *   npx icloud-memo-explorer view ./my-notes           # View existing notes
 *   npx icloud-memo-explorer fetch -o ./my-notes       # Fetch only
 */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { authenticate } from "./auth.js";
import { fetchNotes } from "./fetcher.js";
import { recordsToNotes, exportToMarkdown } from "./exporter.js";
import { startViewer } from "./viewer.js";

const DEFAULT_OUTPUT = "./icloud-notes";

async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function doFetch(appleId: string, outputDir: string): Promise<string> {
  const absDir = resolve(outputDir);

  console.log(`\nAuthenticating as ${appleId}...`);
  const authState = await authenticate(appleId);

  if (!authState.webservices) {
    throw new Error("Failed to get iCloud service URLs. Please try again.");
  }

  console.log("Fetching notes from iCloud...");
  const records = await fetchNotes(authState, appleId, (count) => {
    process.stdout.write(`\r  ${count} records fetched...`);
  });
  console.log(`\n  Total: ${records.length} records`);

  console.log("Decoding and exporting to Markdown...");
  const notes = recordsToNotes(records);
  const saved = exportToMarkdown(notes, absDir);

  console.log(`\n  ${saved} notes saved to ${absDir}`);
  return absDir;
}

const program = new Command();

program
  .name("icloud-memo-explorer")
  .description("Export and browse your iCloud Notes as Markdown.")
  .version("0.1.0");

// Default command: interactive fetch + view
program
  .argument("[directory]", "Notes directory to view (skip fetch if provided)")
  .option("--apple-id <email>", "Apple ID email")
  .option("-o, --output <dir>", "Output directory for notes", DEFAULT_OUTPUT)
  .option("-p, --port <number>", "Viewer port", "3000")
  .option("--no-open", "Don't auto-open browser")
  .action(async (directory, options) => {
    let notesDir: string;

    if (directory && existsSync(resolve(directory))) {
      // View existing notes
      notesDir = resolve(directory);
      console.log(`Viewing notes from ${notesDir}`);
    } else {
      // Fetch then view
      let appleId = options.appleId;
      if (!appleId) {
        appleId = await prompt("Apple ID (email): ");
      }
      notesDir = await doFetch(appleId, options.output);
    }

    await startViewer(notesDir, parseInt(options.port, 10));

    // Auto-open browser
    if (options.open !== false) {
      try {
        const open = (await import("open")).default;
        await open(`http://localhost:${options.port}`);
      } catch {
        // open is optional
      }
    }
  });

// Fetch subcommand
program
  .command("fetch")
  .description("Fetch notes from iCloud and save as Markdown")
  .option("--apple-id <email>", "Apple ID email")
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT)
  .action(async (options) => {
    let appleId = options.appleId;
    if (!appleId) {
      appleId = await prompt("Apple ID (email): ");
    }
    await doFetch(appleId, options.output);
  });

// View subcommand
program
  .command("view")
  .description("Browse exported Markdown notes in the browser")
  .argument("<directory>", "Directory containing .md notes")
  .option("-p, --port <number>", "Port number", "3000")
  .option("--no-open", "Don't auto-open browser")
  .action(async (directory, options) => {
    const notesDir = resolve(directory);
    if (!existsSync(notesDir)) {
      console.error(`Error: Directory not found: ${notesDir}`);
      process.exit(1);
    }

    await startViewer(notesDir, parseInt(options.port, 10));

    if (options.open !== false) {
      try {
        const open = (await import("open")).default;
        await open(`http://localhost:${options.port}`);
      } catch {
        // open is optional
      }
    }
  });

program.parse();
