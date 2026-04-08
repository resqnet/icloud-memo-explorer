# icloud-memo-explorer

Export and browse your iCloud Notes as Markdown — one command, no setup.

## Quick Start

```bash
npx icloud-memo-explorer
```

This will:

1. Ask for your Apple ID
2. Authenticate (supports 2FA)
3. Fetch all your notes from iCloud
4. Save them as Markdown files
5. Open a browser-based viewer

## Usage

### Interactive (fetch + view)

```bash
npx icloud-memo-explorer
npx icloud-memo-explorer --apple-id you@example.com
```

### Fetch only

```bash
npx icloud-memo-explorer fetch --apple-id you@example.com -o ./my-notes
```

### View existing notes

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

Notes are saved as Markdown files with YAML frontmatter:

```markdown
---
title: "My Note Title"
created: 2024-01-15T10:30:00Z
modified: 2024-03-20T14:22:00Z
---

Note content here...
```

Filename format: `YYYYMMDD_title.md`

## Authentication

- Uses Apple's SRP (Secure Remote Password) authentication
- Supports two-factor authentication (2FA)
- Session is cached in `~/.icloud-memo-explorer/` for reuse
- No passwords are stored — only session tokens

## Requirements

- Node.js >= 18
- An Apple ID with iCloud Notes

## Viewer

The built-in viewer provides:

- Dark theme UI
- Real-time search
- Markdown rendering
- Responsive layout

## License

MIT
