---
name: planning
description: Creates implementation plans for substantial features, refactors, migrations, or cross-package changes. Use before coding any large feature or refactor; all resulting plans must be stored under .agents/plans/.
---

# Planning

Use this skill before implementing a large feature, refactor, migration, or change spanning multiple packages.

## Required workflow

1. Read `AGENTS.md` and the relevant code, tests, and existing plans.
2. Check `.agents/plans/` for an approved plan that already covers the work.
3. If none exists, create a descriptive Markdown plan in `.agents/plans/` before editing production code.
4. Make the plan concrete enough that another agent can implement it without making major architecture decisions.
5. Keep the plan current when implementation reveals a materially different design.

## Plan contents

Include:

- context and user outcome,
- scope and explicit non-goals,
- invariants and security constraints,
- affected files/packages and ownership boundaries,
- ordered implementation steps,
- API/schema/migration changes,
- tests and verification commands,
- compatibility, deployment, and rollback risks,
- completion checklist.

Prefer small independently verifiable phases. For parallel work, assign non-overlapping file ownership and identify integration sequencing.

## Storage rule

All plans must live in `.agents/plans/`. Do not create `PLAN.md` at the repository root or leave the only plan in chat, an issue, or a temporary directory.
