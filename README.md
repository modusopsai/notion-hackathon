# Notion Hackathon Data Sync Worker

Notion Worker that syncs operational data from GitHub, Sentry, and Granola into managed Notion databases.

## Databases

- `GitHub Activity`: repository event stream for `modusopsai/notion-hackathon`.
- `GitHub Issues and PRs`: issues and pull requests from the configured repository.
- `Sentry Issues`: unresolved Sentry issues, optionally filtered by project slug.
- `Granola Notes`: meeting note summaries and detected action items.

## Syncs

- `githubActivitySync`: incremental sync every 15 minutes from the GitHub repository events API.
- `githubIssuesBackfill`: manual replace-mode sync for the full issue and pull request history.
- `githubIssuesDelta`: incremental sync every 5 minutes for recently updated issues and pull requests.
- `sentryIssuesSync`: replace-mode sync every 30 minutes from Sentry unresolved issues.
- `granolaNotesBackfill`: manual replace-mode sync from Granola notes for initial load and drift cleanup.
- `granolaNotesDelta`: incremental sync every 5 minutes from Granola notes updated after the saved cursor.

Replace-mode syncs delete stale rows only after every page in the upstream dataset has completed successfully.

## Webhooks

- `sentryIssueAlertWebhook`: receives Sentry issue-alert webhook deliveries, verifies `Sentry-Hook-Signature`, and upserts the issue into an existing Notion database.

The webhook writes through the Notion API and is separate from the managed `sentryIssuesSync` database. Keep `sentryIssuesSync` enabled as a backfill/recovery path for missed webhook deliveries.

## Environment

Copy `.env.example` to `.env` locally, then fill in secrets. Do not commit `.env`.

```bash
GITHUB_TOKEN=
GITHUB_OWNER=modusopsai
GITHUB_REPO=notion-hackathon

NOTION_API_TOKEN=
SENTRY_NOTION_API_TOKEN=
NOTION_SENTRY_DATABASE_ID=
SENTRY_NOTION_DATABASE_ID=

SENTRY_AUTH_TOKEN=
SENTRY_ORG_SLUG=
SENTRY_PROJECT_SLUGS=
SENTRY_WEBHOOK_CLIENT_SECRET=

GRANOLA_API_KEY=
GRANOLA_INCLUDE_TRANSCRIPT=false
```

`GITHUB_TOKEN` needs read access to the configured repository. The issue/PR syncs use GitHub's REST issues endpoint, where pull requests are returned as issue records with a `pull_request` marker. Run `githubIssuesBackfill` first for the initial load, then leave `githubIssuesDelta` enabled for ongoing updates. The backfill's replace mode is the cleanup path for deleted or transferred items that no longer appear in the repository.

`SENTRY_NOTION_API_TOKEN` is required for deployed webhook writes to Notion. The worker also accepts `NOTION_API_TOKEN` locally for non-tool capabilities or local Notion API checks that use an internal integration token. Create one at https://www.notion.so/profile/integrations/internal, grant it access to the relevant pages/databases, then paste the token into `.env`.

`SENTRY_NOTION_DATABASE_ID` must point at a Notion database or data source with these properties: `Issue`, `Sentry Issue ID`, `Culprit`, `Level`, `Status`, `Project`, `User Count`, `Event Count`, `First Seen`, `Last Seen`, and `Permalink`. The worker also accepts `NOTION_SENTRY_DATABASE_ID` for local development, but deployed worker environment variables cannot use the reserved `NOTION_` prefix.

`SENTRY_WEBHOOK_CLIENT_SECRET` must match the client secret from the Sentry service hook or internal integration that sends issue-alert webhook deliveries.

`SENTRY_ORG_SLUG` and `SENTRY_PROJECT_SLUGS` are preferred names. The worker also accepts the existing local aliases `SENTRY_ORG` and `SENTRY_PROJECT`. `SENTRY_PROJECT_SLUGS` accepts a comma-separated list. `GRANOLA_INCLUDE_TRANSCRIPT=true` includes transcript text in page content when Granola returns it; database properties still store summary and action items only.

Granola's MCP endpoint (`https://mcp.granola.ai/mcp`) is for authenticated AI-client query access, not automated worker sync. The worker uses Granola's REST API because Granola API webhooks are not available yet.

## Commands

```bash
npm run check
ntn doctor
ntn workers exec checkNotionConnection --local -d '{}'
ntn workers deploy
ntn workers webhooks list
ntn workers sync trigger githubActivitySync --preview
ntn workers sync trigger githubIssuesBackfill --preview
ntn workers sync trigger githubIssuesDelta --preview
ntn workers sync trigger sentryIssuesSync --preview
ntn workers sync trigger granolaNotesBackfill --preview
ntn workers sync trigger granolaNotesDelta --preview
```

## Sentry webhook setup

1. Deploy the worker with `ntn workers deploy`.
2. Run `ntn workers webhooks list` and copy the URL for `sentryIssueAlertWebhook`.
3. In Sentry, create a service hook or internal integration webhook for issue alerts and use that URL.
4. Set `SENTRY_WEBHOOK_CLIENT_SECRET` to the Sentry hook/integration secret.
5. Make sure `NOTION_API_TOKEN` has access to the database identified by `SENTRY_NOTION_DATABASE_ID`.
6. Send a Sentry test delivery or trigger an issue alert; repeated deliveries update the same Notion page by `Sentry Issue ID`.

If you change sync state handling or need a full refresh, reset a sync before triggering it:

```bash
ntn workers sync state reset githubIssuesBackfill
ntn workers sync trigger githubIssuesBackfill --preview
ntn workers sync state reset sentryIssuesSync
ntn workers sync trigger sentryIssuesSync --preview
ntn workers sync state reset granolaNotesDelta
ntn workers sync trigger granolaNotesDelta --preview
```
