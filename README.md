# icloud-memo-explorer

Export and browse your iCloud Notes as Markdown — one command, no setup.

iCloud Notes (Apple メモ) をMarkdownファイルとしてエクスポートし、ブラウザで閲覧できるCLIツールです。

## Quick Start

```bash
npx icloud-memo-explorer
```

This will:

1. Ask for your Apple ID
2. Authenticate via SRP (supports 2FA)
3. Fetch all your notes from iCloud
4. Save them as Markdown files with YAML frontmatter
5. Open a browser-based viewer at `http://localhost:3000`

## Usage

### Interactive (fetch + view)

```bash
# Prompt for Apple ID interactively
npx icloud-memo-explorer

# Specify Apple ID directly
npx icloud-memo-explorer --apple-id you@example.com
```

### Fetch only

Download notes as Markdown files without launching the viewer.

```bash
npx icloud-memo-explorer fetch --apple-id you@example.com -o ./my-notes
```

### View existing notes

Browse previously exported Markdown notes.

```bash
npx icloud-memo-explorer view ./my-notes
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--apple-id <email>` | Apple ID | _(interactive prompt)_ |
| `-o, --output <dir>` | Output directory | `./icloud-notes` |
| `-p, --port <number>` | Viewer port | `3000` |
| `--no-open` | Don't auto-open browser | |

## Output Format

Notes are saved as individual Markdown files with YAML frontmatter:

```markdown
---
title: "Meeting Notes"
created: 2024-01-15T10:30:00Z
modified: 2024-03-20T14:22:00Z
---

Note content here...
```

- Filename: `YYYYMMDD_title.md`
- Encoding: UTF-8
- CJK (Japanese/Chinese/Korean) text is fully supported

## How It Works

### Authentication

1. **SRP (Secure Remote Password)** protocol — the same method used by iCloud.com
2. Supports **two-factor authentication (2FA)** — enter the code sent to your device
3. Session tokens are cached in `~/.icloud-memo-explorer/` for reuse
4. **No passwords are stored** — only session tokens

### Data Fetching

- Connects to Apple's CloudKit API to fetch notes from the `Notes` zone
- Handles pagination automatically for large collections (1000+ notes)
- Decodes zlib/gzip compressed protobuf content
- Extracts readable text from binary data (CJK-aware)

### Viewer

The built-in browser viewer provides:

- Dark theme UI
- Real-time search across all notes
- Markdown rendering with syntax highlighting
- Responsive layout (desktop + mobile)
- No external dependencies — single HTML page served locally

## Requirements

- **Node.js >= 18**
- An Apple ID with iCloud Notes enabled

## Architecture

```
src/
├── cli.ts         # CLI entry point (commander)
├── auth.ts        # iCloud authentication (SRP + 2FA)
├── srp.ts         # SRP-6a cryptographic protocol
├── session.ts     # HTTP session with cookie persistence
├── fetcher.ts     # CloudKit API client
├── decoder.ts     # Note content decoder (zlib/protobuf)
├── exporter.ts    # Markdown file exporter
├── viewer.ts      # Browser-based viewer (Express)
└── types.ts       # TypeScript type definitions
```

## Security

- Authentication uses Apple's SRP protocol — passwords are never sent in plaintext
- Session tokens are stored locally in `~/.icloud-memo-explorer/`
- All communication with Apple servers uses HTTPS
- No data is sent to any third-party service

## Development

```bash
git clone https://github.com/resqnet/icloud-memo-explorer.git
cd icloud-memo-explorer
npm install
npm run build
node dist/cli.js
```

## License

MIT
