<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# components

## Purpose
Shared React components for the Basecamp clone application. Includes composable UI elements, dialogs, form components, and specialized view components for clients, discussions, and projects. All components are client-side unless marked as server components.

## Key Files
| File | Description |
|------|-------------|
| `markdown-editor.tsx` | Rich markdown editor using MDXEditor with toolbar for formatting (bold, italic, links, lists, headings) |
| `file-thumbnail-preview.tsx` | Generates and displays thumbnail previews for files (images, PDFs, Office docs) with polling support |
| `project-dialog-form.tsx` | Form dialog for creating/editing projects with validation |

## Subdirectories
- `clients/` - Client management components (table, header, tabs, badges)
- `discussions/` - Discussion/comment components (composer, markdown rendering, attachments)
- `projects/` - Project view and management components (board, list, filters, billing)

## For AI Agents

### Working In This Directory
- **Client-side components**: All components in `components/` are marked with `"use client"` directive
- **Styling**: CSS classes correspond to styles in `app/globals.css` (e.g., `markdownContent`, `clientsTable`)
- **Props**: Components accept typed props; prefer composition over large prop interfaces
- **Memoization**: Heavy components use React.memo() with custom comparators to prevent unnecessary re-renders (e.g., MarkdownEditor)

### Common Patterns
- **Controlled components**: Form inputs managed by parent state (markdown editors, text inputs)
- **Type safety**: Most components import types from `lib/types/` (ClientRecord, ProjectColumn, etc.)
- **Formatting utilities**: Use `lib/` helpers like `markdownToPlainText()`, `formatBytes()`, `formatDate()`
- **Drag-and-drop**: Projects board uses React drag event handlers for kanban-style board
- **File handling**: Thumbnails and attachments use Dropbox API with token refresh logic

## Dependencies

### Internal
- `lib/types/` - Type definitions (client-record, client-stats, project-utils)
- `lib/` - Utilities (markdown, formatting, browser-auth, project-utils)
- `components/one-shot-button` - Shared button component

### External
- `@mdxeditor/editor` - Markdown editor with plugins (headings, lists, links, shortcuts)
- `next/link` - Client navigation
- React hooks (memo, useCallback, useMemo, useRef, useEffect, useState)

<!-- MANUAL: -->
