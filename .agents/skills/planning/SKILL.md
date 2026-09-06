---
name: planning
description: Creates implementation plans for substantial features, refactors, migrations, or cross-package changes. Use before coding any large feature or refactor; all resulting plans must be stored under .agents/plans/ as numbered files (NNN-SLUG.md).
---

# Planning

Use this skill before implementing a large feature, refactor, migration, or change spanning multiple packages.

## Required workflow

1. Read `AGENTS.md` and the relevant code, tests, and existing plans.
2. Check `.agents/plans/` for an approved plan that already covers the work.
3. If none exists, create a numbered Markdown plan in `.agents/plans/` before editing production code.
4. Make the plan concrete enough that another agent can implement it without making major architecture decisions.
5. Keep the plan current when implementation reveals a materially different design.
6. After the work is fully implemented and committed, delete the plan unless it remains a living source-of-truth spec (for example the Stage 1 plan).

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

This directory is for implementation plans only. Do not store progress reports, handoffs, or completion notes there.

## Numbering

Name every new plan `NNN-SLUG.md`:

- `NNN` is a zero-padded 3-digit sequence number (`001`, `002`, …).
- `SLUG` is a short SCREAMING_SNAKE description (`DEPLOY_CONFIGS`, `VAULT_SEARCH`).

To pick `NNN`:

1. List `.agents/plans/`.
2. Read the highest existing numeric prefix. Treat a missing or empty directory as `000`.
3. Use the next number. Never reuse a number, even after a plan is deleted.

Examples: `001-TEPHRA_STAGE1_PLAN.md`, `002-AUTH_AND_DEPLOYMENT_MODES_PLAN.md`.

## Lifecycle

- Create the numbered plan before coding.
- Keep the plan current during implementation.
- When the work is fully implemented and the change is committed, delete the plan file. Do not leave completed feature plans in `.agents/plans/`.
- Keep a plan only while it is still the living source of truth for unfinished or ongoing work (the Stage 1 spec is the current exception).
