# Notion Hackathon Data Sync Worker

Notion Worker that syncs operational data from GitHub, Sentry, and Granola into managed Notion databases.

## Databases

- `GitHub Activity`: repository event stream for `modusopsai/notion-hackathon`.
- `Sentry Issues`: unresolved Sentry issues, optionally filtered by project slug.
- `Granola Notes`: meeting note summaries and detected action items.

## Syncs

- `githubActivitySync`: incremental sync every 15 minutes from the GitHub repository events API.
- `sentryIssuesSync`: replace-mode sync every 30 minutes from Sentry unresolved issues.
- `granolaNotesSync`: replace-mode sync every hour from Granola notes.

Replace-mode syncs delete stale rows only after every page in the upstream dataset has completed successfully.

## Environment

Copy `.env.example` to `.env` locally, then fill in secrets. Do not commit `.env`.

```bash
GITHUB_TOKEN=
GITHUB_OWNER=modusopsai
GITHUB_REPO=notion-hackathon

SENTRY_AUTH_TOKEN=
SENTRY_ORG_SLUG=
SENTRY_PROJECT_SLUGS=

GRANOLA_API_KEY=
GRANOLA_INCLUDE_TRANSCRIPT=false
```

`SENTRY_PROJECT_SLUGS` is optional and accepts a comma-separated list. `GRANOLA_INCLUDE_TRANSCRIPT=true` includes transcript text in page content when Granola returns it; database properties still store summary and action items only.

## Commands

```bash
npm run check
ntn doctor
ntn workers deploy
ntn workers sync trigger githubActivitySync --preview
ntn workers sync trigger sentryIssuesSync --preview
ntn workers sync trigger granolaNotesSync --preview
```

If you change sync state handling or need a full refresh, reset a sync before triggering it:

```bash
ntn workers sync state reset sentryIssuesSync
ntn workers sync trigger sentryIssuesSync --preview
```
