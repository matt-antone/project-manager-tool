<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# discussions

## Purpose
Discussion and comment components for rendering markdown content, composing new messages, managing file attachments, and displaying discussion threads. Handles rich text editing, file uploads, and conversion between markdown and HTML.

## Key Files
| File | Description |
|------|-------------|
| `discussion-composer.tsx` | Composable comment form with editor slot, file drag-drop zone, attachment list, and submit button |
| `create-discussion-dialog.tsx` | Modal dialog for creating new discussions with title input, markdown editor, and attachments |
| `markdown-html.tsx` | Renders markdown as HTML with memo optimization to prevent re-renders |
| `attachment-collections.tsx` | Displays collection of file attachments with previews, sizes, and removal controls |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- **Client-side components**: All marked with `"use client"` directive
- **Styling**: Uses CSS classes from `globals.css` (e.g., `discussionSection`, `commentDropZone`, `markdownContent`)
- **Editor integration**: Accepts ReactNode editor prop (typically MarkdownEditor) for flexible markdown editing
- **File handling**: Manages FileList and File[] arrays; tracks upload progress and error states

### Common Patterns
- **Attachment lifecycle**: PendingAttachment type tracks file state (queued → hashing → uploading → done/error)
- **Drag-drop zones**: onDragEnter/Over/Leave prevent defaults and set active state; onDrop handles FileList
- **Form submission**: canSubmit prop controls button enabled state; submitLabel customizable
- **Dialog refs**: HTML dialog element managed via RefObject for show/close control
- **Attachment formatting**: formatAttachmentStage() callback converts attachment.stage to user-facing label

## Dependencies

### Internal
- `components/one-shot-button` - Submit/cancel button component
- `components/markdown-editor` - Rich markdown editor
- `lib/format-bytes` - Converts bytes to human-readable format (e.g., "2.5 MB")
- Styling from `app/globals.css`

### External
- React (memo, ReactNode, RefObject, useState, useEffect, useCallback)
- HTML5 dialog element for modal behavior

<!-- MANUAL: -->
