<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Root Application Directory

## Purpose
Main App Router entry point with navigation, core layout, and redirect to projects/clients

## Key Files
| File | Description |
|------|-------------|
| `header.tsx` | Header.Tsx |
| `layout.tsx` | Layout component for this route |
| `page.tsx` | Server-side page component |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `[id]/` | Dynamic project route with discussion threads |
| `admin/` | Admin-only features and utilities |
| `api/` | RESTful API endpoints |
| `archive/` | UI for viewing archived projects |
| `auth/` | OAuth and session management |
| `avatar/` | User avatar image delivery/generation |
| `billing/` | Project billing and hours tracking |
| `clients/` | List and manage all clients |
| `feeds/` | User activity feeds |
| `flow/` | Workflow management interface |
| `profile/` | User profile endpoint |
| `projects/` | Project CRUD operations (list, create, bulk operations) |
| `settings/` | User and workspace settings |
| `site-settings/` | Global site configuration |
| `users/` | User directory |

## For AI Agents

### Working In This Directory
This route has both layout and page. Layout wraps the page component. Check for dynamic segments like `[id]` requiring path parameters.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
