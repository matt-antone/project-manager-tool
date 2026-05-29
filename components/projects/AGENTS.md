<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# projects

## Purpose
Project management and display components. Includes kanban board view, list view, filtering, billing tracking, archival, and workspace organization. Components support drag-and-drop status transitions and rich project metadata display.

## Key Files
| File | Description |
|------|-------------|
| `projects-board-view.tsx` | Kanban-style board with draggable project cards across status columns (new → in_progress → blocked → complete) |
| `projects-list-view.tsx` | Table-based view of projects grouped by column with inline editing, status badges, and bulk actions |
| `projects-filter-shelf.tsx` | Filter UI for projects (by client, status, archived) with clear/apply controls |
| `projects-archive.tsx` | Archive browser with table display and restore functionality |
| `archive-tab.tsx` | Tab component for switching between active/archived projects |
| `projects-billing.tsx` | Billing table showing projects with status, hours, and move-to-billing action |
| `billing-project-row.tsx` | Individual project row in billing view with editable hours and status |
| `projects-workspace-shell.tsx` | Layout shell wrapping board/list views with shared state and utilities |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- **Client-side components**: All marked with `"use client"` directive
- **Styling**: Uses CSS classes from `globals.css` (e.g., `projectsBoard`, `projectCard`, `projectColumn`)
- **Drag-and-drop**: Native HTML drag events (onDragStart, onDragOver, onDrop) with column targeting
- **Data types**: Components accept ProjectBoardItem and ProjectListItem types with extended metadata (status, deadline, tags, hours)
- **Formatting**: Uses `formatProjectCreatedAtLocal()`, `formatProjectDeadlineLocal()` for date display

### Common Patterns
- **Column definitions**: ProjectColumnDefinition array defines board columns (key, title, subtitle)
- **Status tracking**: dragOverColumn, draggingProjectId, justMovedProjectId track in-flight drag state
- **Deadline highlighting**: `hasMissingHours()` utility checks if project missing total hours (red flag)
- **Markdown stripping**: `markdownToPlainText()` converts project descriptions for display
- **Date comparison window**: COMPARISON_WINDOW_MS (30 days) highlights recently created/modified projects
- **Render callbacks**: renderProjectTitle() callback allows parent to customize title display (e.g., links)
- **Billing transition**: onSendToBilling() handler moves project to billing status

## Dependencies

### Internal
- `lib/types/` - ProjectColumn, ProjectBoardItem, ProjectListItem types
- `lib/project-utils` - formatProjectCreatedAtLocal(), formatProjectDeadlineLocal(), normalizeProjectColumn(), hasMissingHours()
- `lib/markdown` - markdownToPlainText()
- `components/one-shot-button` - Action buttons (archive, billing, create)
- Styling from `app/globals.css`

### External
- `next/link` - Navigation to project detail pages
- React (useEffect, DragEvent, CSSProperties, useState, useCallback, ReactNode)

<!-- MANUAL: -->
