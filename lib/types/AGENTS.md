<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/types/

## Purpose
Shared TypeScript type definitions used across server and client code. Defines record structures for clients and projects with their associated metadata and statistics.

## Key Files
| File | Description |
|------|-------------|
| `client-record.ts` | Client database record type with billing and contact fields |
| `client-stats.ts` | Client statistics aggregations (projects, active threads, storage usage) |

## For AI Agents

### Working In This Directory
- **Client-side safe**: These are pure type definitions with no runtime code; safe to import on client.
- **No side effects**: Definition-only module.
- **Zod schemas elsewhere**: Validation schemas for these types live in respective feature modules (not here).

### Common Patterns
- Exhaustive type definitions matching Supabase schema
- Optional fields for nullable DB columns
- Stats types aggregate computed values from queries

## Dependencies

### Internal
- Imported by `lib/` modules for type-safe query results
- Imported by `app/` routes for request/response payloads
- Imported by `components/` for prop types

### External
- None (pure TypeScript types)

<!-- MANUAL: -->
