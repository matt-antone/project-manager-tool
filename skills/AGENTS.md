<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# skills

## Purpose

Local Claude Code skills for the basecamp-clone project. Each skill is a symlink to a global skill definition in `.agents/skills/`. Skills provide specialized workflows and guidance for development tasks. Individual skills are not deepinit-documented; each maintains its own internal structure.

## Key Files / Subdirectories

| Skill | Purpose |
|-------|---------|
| `adapt` | Adapt designs or code to new requirements or contexts |
| `animate` | Animation and motion design guidance |
| `arrange` | Layout and spatial organization |
| `audit` | Audit and review workflows |
| `bolder` | Enhance emphasis and visual weight |
| `clarify` | Clarification and documentation |
| `colorize` | Color and theming work |
| `critique` | Code and design critique workflows |
| `delight` | Refinement and delightful details |
| `distill` | Simplification and distillation |
| `extract` | Extract and refactor patterns |
| `frontend-design` | Frontend component and UI design |
| `harden` | Security and robustness hardening |
| `normalize` | Standardization and normalization |
| `onboard` | Onboarding and setup workflows |
| `optimize` | Performance and optimization |
| `overdrive` | High-intensity focused work mode |
| `polish` | Final polish and refinement |
| `quieter` | Quiet or low-intensity mode |
| `supabase` | Supabase-specific development guidance |
| `supabase-postgres-best-practices` | PostgreSQL best practices for Supabase |
| `teach-impeccable` | Teaching and knowledge transfer |
| `typeset` | Typography and text styling |

## For AI Agents

### Working In This Directory

- **Symlinked to global skills**: All skill directories are symlinks to `.agents/skills/` in the global Claude Code configuration.
- **Do not recurse**: Each skill maintains its own structure. Generate AGENTS.md at the `skills/` level only, not inside individual skill directories.
- **Skill activation**: Use the `Skill` tool to invoke skills by name (e.g., `frontend-design`, `supabase`).

### Dependencies

Skills are dependencies of Claude Code workflows and other development tasks. No inter-skill dependencies exist at this level.

<!-- MANUAL: -->
