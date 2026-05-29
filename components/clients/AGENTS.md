<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# clients

## Purpose
Client management components for displaying, editing, and filtering client information. Includes data tables, status indicators, project tabs, and edit dialogs for client metadata (name, repos, domains, archive status).

## Key Files
| File | Description |
|------|-------------|
| `clients-table.tsx` | Displays paginated table of clients with active project count and last activity date |
| `client-header.tsx` | Shows client details: name, archived status, GitHub repos, domains, and activity stats |
| `client-tabs.tsx` | Tab switcher for active/archived clients with counts |
| `client-projects-table.tsx` | Lists all projects under a specific client with status and metadata |
| `client-status-badge.tsx` | Badge component showing client archive status |
| `client-edit-dialog.tsx` | Form dialog for editing client name, GitHub repos, and domains |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- **Client-side components**: All marked with `"use client"` directive
- **Styling**: Uses CSS classes from `globals.css` (e.g., `clientsTable`, `clientHeader`, `clientArchivedBadge`)
- **Data types**: All components accept types from `lib/types/` (ClientRecord, ClientWithStats, ClientDetailStats, ClientTabCounts)
- **Navigation**: Uses `next/link` for client detail pages (e.g., `/clients/${r.id}`)

### Common Patterns
- **Tab state**: ClientTabs manages which tab is active (active/archived); parent passes counts
- **Empty states**: Tables show placeholder messages when no rows match current tab
- **Date formatting**: Uses `toISOString().slice(0, 10)` to format ISO dates as YYYY-MM-DD strings
- **External links**: GitHub repo links constructed via `repoHref()` utility (supports full URLs or `owner/repo` shorthand)
- **Dialog forms**: Edit dialog uses form submission with callback to parent for persistence

## Dependencies

### Internal
- `lib/types/client-record` - ClientRecord, ClientDetailStats types
- `lib/types/client-stats` - ClientWithStats, ClientTabCounts, ClientDetailStats
- Styling from `app/globals.css`

### External
- `next/link` - Client-side navigation
- React (ReactNode, RefObject, useState, useCallback, useEffect)

<!-- MANUAL: -->
