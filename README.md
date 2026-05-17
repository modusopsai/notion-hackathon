# Notion Hackathon Data Sync Worker

Notion Worker that syncs operational data from GitHub, Sentry, Granola, and Slack into managed Notion databases.

## Databases

- `GitHub Activity`: repository event stream for the configured source repository.
- `GitHub Issues and PRs`: issues and pull requests from the configured repository.
- `Sentry Issues`: unresolved Sentry issues, optionally filtered by project slug.
- `Granola Notes`: meeting note summaries and detected action items.
- `Slack Messages`: messages from configured Slack conversations.

## Syncs

- `githubActivitySync`: incremental sync every 15 minutes from the GitHub repository events API.
- `githubIssuesBackfill`: manual replace-mode sync for the full issue and pull request history.
- `githubIssuesDelta`: incremental sync every 5 minutes for recently updated issues and pull requests.
- `sentryIssuesSync`: replace-mode sync every 30 minutes from Sentry unresolved issues into the configured Sentry Notion data source.
- `granolaNotesBackfill`: manual replace-mode sync from Granola notes for initial load and drift cleanup.
- `granolaNotesDelta`: incremental sync every 5 minutes from Granola notes updated after the saved cursor.
- `slackMessagesBackfill`: manual replace-mode sync across configured Slack conversations.
- `slackMessagesDelta`: incremental sync every 5 minutes for new Slack messages in configured conversations.

Replace-mode syncs delete stale rows only after every page in the upstream dataset has completed successfully.

## Webhooks

- `sentryIssueAlertWebhook`: receives Sentry issue-alert webhook deliveries, verifies `Sentry-Hook-Signature`, and upserts the issue into an existing Notion database.

The webhook writes through the Notion API into the same configured Sentry Notion data source used by `sentryIssuesSync`. Keep `sentryIssuesSync` enabled as a backfill/recovery path for missed webhook deliveries.

## Environment

Copy `.env.example` to `.env` locally, then fill in secrets. Do not commit `.env`.

```bash
GITHUB_TOKEN=
GITHUB_OWNER=StartupIntros
GITHUB_REPO=startupintros-nextjs
GITHUB_NOTION_API_TOKEN=
GITHUB_NOTION_DATA_SOURCE_ID=3623edae28d380cdafa7000b11385255
GITHUB_WEBHOOK_SECRET=
GITHUB_CONTEXT_COMMENTS_LIMIT=10
GITHUB_CONTEXT_FILES_LIMIT=50
GITHUB_CONTEXT_COMMITS_LIMIT=20
GITHUB_CONTEXT_REVIEWS_LIMIT=20

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
GRANOLA_NOTION_DATA_SOURCE_ID=3623edae-28d3-8095-958c-000b712611af

SLACK_BOT_TOKEN=
SLACK_CHANNEL_IDS=C1234567890,D1234567890,G1234567890
SLACK_CHANNEL_NAMES=C1234567890=si-newsletter,D1234567890=dm-name,G1234567890=group-dm-name
SLACK_HISTORY_PAGE_SIZE=15
SLACK_REQUESTS_PER_MINUTE=1
```

`GITHUB_TOKEN` needs read access to the configured repository. The issue/PR syncs use GitHub's REST issues endpoint, where pull requests are returned as issue records with a `pull_request` marker. Run `githubIssuesBackfill` first for the initial load, then leave `githubIssuesDelta` enabled for ongoing updates. The backfill's replace mode is the cleanup path for deleted or transferred items that no longer appear in the repository.

This worker repo defaults to `modusopsai/notion-hackathon` in source. Set `GITHUB_OWNER=StartupIntros` and `GITHUB_REPO=startupintros-nextjs` in `.env` or remote worker env when you want the syncs to pull Startup Intros data.

`GITHUB_NOTION_DATA_SOURCE_ID` points at the existing Notion data source that should receive GitHub issues and pull requests. The default target is the `GitHub DB` data source, `3623edae28d380cdafa7000b11385255`, inside the `Data Sources` database. `GITHUB_NOTION_API_TOKEN` is preferred for deployed GitHub Notion writes; the worker falls back to `NOTION_API_TOKEN` locally. `GITHUB_WEBHOOK_SECRET` must match the secret configured on the GitHub webhook.

Direct GitHub Notion writes enrich each issue/PR page with the full description, recent comments, and, for pull requests, reviews, changed files, and commits. `GITHUB_CONTEXT_COMMENTS_LIMIT`, `GITHUB_CONTEXT_FILES_LIMIT`, `GITHUB_CONTEXT_COMMITS_LIMIT`, and `GITHUB_CONTEXT_REVIEWS_LIMIT` bound the extra GitHub API reads and page body size. Set a limit to `0` to skip that section.

`SENTRY_NOTION_API_TOKEN` is required for deployed webhook writes to Notion. The worker also accepts `NOTION_API_TOKEN` locally for non-tool capabilities or local Notion API checks that use an internal integration token. Create one at https://www.notion.so/profile/integrations/internal, grant it access to the relevant pages/databases, then paste the token into `.env`.

`SENTRY_NOTION_DATABASE_ID` must point at a Notion database or data source with these properties: `Issue`, `Sentry Issue ID`, `Culprit`, `Level`, `Status`, `Project`, `User Count`, `Event Count`, `First Seen`, `Last Seen`, and `Permalink`. The worker also accepts `NOTION_SENTRY_DATABASE_ID` for local development, but deployed worker environment variables cannot use the reserved `NOTION_` prefix.

`SENTRY_WEBHOOK_CLIENT_SECRET` must match the client secret from the Sentry service hook or internal integration that sends issue-alert webhook deliveries.

`SENTRY_ORG_SLUG` and `SENTRY_PROJECT_SLUGS` are preferred names. The worker also accepts the existing local aliases `SENTRY_ORG` and `SENTRY_PROJECT`. `SENTRY_PROJECT_SLUGS` accepts a comma-separated list. `GRANOLA_INCLUDE_TRANSCRIPT=true` includes transcript text in page content when Granola returns it; database properties still store summary and action items only.

`GRANOLA_NOTION_DATA_SOURCE_ID` points at the existing Notion database/data source that should receive Granola notes. The default target is `3623edae-28d3-8095-958c-000b712611af`. Make sure the `NOTION_API_TOKEN` internal integration has access to that database. The Granola syncs write directly to this data source through the Notion API; do not use `--preview` for Granola syncs because direct Notion writes still happen inside the sync execution.

Granola's MCP endpoint (`https://mcp.granola.ai/mcp`) is for authenticated AI-client query access, not automated worker sync. The worker uses Granola's REST API because Granola API webhooks are not available yet.

`SLACK_BOT_TOKEN` needs the history scopes for the conversation types you import: `channels:history` for public channels, `groups:history` for private channels, `im:history` for 1:1 DMs, and `mpim:history` for group DMs. Add `channels:read`, `groups:read`, `im:read`, and `mpim:read` for easier allowlist discovery, plus `users:read` if you want to resolve DM user names while configuring labels. Reinstall the Slack app after changing scopes.

Set `SLACK_CHANNEL_IDS` to a comma-separated allowlist of Slack conversation IDs. Public channels usually start with `C`, 1:1 DMs with `D`, and private channels or group DMs often with `G`, for example `C1234567890,D1234567890,G1234567890`. `SLACK_CHANNEL_NAMES` is optional display metadata in `id=name` form, for example `C1234567890=si-newsletter,D1234567890=dm-name,G1234567890=group-dm-name`. The worker does not discover or import every accessible DM; DMs and group DMs are imported only when their conversation IDs are explicitly listed.

The Slack app must be able to access each configured conversation. Invite it to private channels where required, and open or add the app in target DMs/group DMs if Slack requires app membership before history can be read. `SLACK_HISTORY_PAGE_SIZE` defaults to `15` and `SLACK_REQUESTS_PER_MINUTE` defaults to `1` to stay compatible with Slack's stricter history limits for many non-Marketplace apps; raise them only for internal/Marketplace-approved apps where your Slack limit allows it.

Slack's history API is cursor-paginated and returns messages newest-first. The backfill sync is the cleanup path for full refreshes. The delta sync polls from the previous Slack timestamp with a one-minute buffer, so it is intended for new-message capture; Slack does not provide delete coverage through this polling path.

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
ntn workers exec githubIssuesNotionBackfill --local -d '{"dryRun":true,"page":null,"updatedSince":null,"includeContext":true}'
ntn workers sync trigger sentryIssuesSync --preview
ntn workers sync trigger granolaNotesBackfill
ntn workers sync trigger granolaNotesDelta
ntn workers sync trigger slackMessagesBackfill --preview
ntn workers sync trigger slackMessagesDelta --preview
```

## Sentry webhook setup

1. Deploy the worker with `ntn workers deploy`.
2. Run `ntn workers webhooks list` and copy the URL for `sentryIssueAlertWebhook`.
3. In Sentry, create a service hook or internal integration webhook for issue alerts and use that URL.
4. Set `SENTRY_WEBHOOK_CLIENT_SECRET` to the Sentry hook/integration secret.
5. Make sure `NOTION_API_TOKEN` has access to the database identified by `SENTRY_NOTION_DATABASE_ID`.
6. Send a Sentry test delivery or trigger an issue alert; repeated deliveries update the same Notion page by `Sentry Issue ID`.

## GitHub webhook setup

1. Make sure the Notion integration token has access to the database identified by `GITHUB_NOTION_DATA_SOURCE_ID`.
2. Run `ntn workers exec githubIssuesNotionBackfill --local -d '{"dryRun":true,"page":null,"updatedSince":null,"includeContext":true}'` to inspect the first GitHub page without writing.
3. Run `ntn workers exec githubIssuesNotionBackfill --local -d '{"dryRun":false,"page":1,"updatedSince":null,"includeContext":true}'` to write the first page.
4. Deploy the worker with `ntn workers deploy`.
5. Run `ntn workers webhooks list` and copy the URL for `githubIssuesWebhook`.
6. In GitHub, create a repository webhook for `issues` and `pull_request` events using that URL and `GITHUB_WEBHOOK_SECRET`.
7. Send a GitHub test delivery or update an issue/PR; repeated deliveries update the same Notion page by `GitHub Item ID`.

If you change sync state handling or need a full refresh, reset a sync before triggering it:

```bash
ntn workers sync state reset githubIssuesBackfill
ntn workers sync trigger githubIssuesBackfill --preview
ntn workers sync state reset sentryIssuesSync
ntn workers sync trigger sentryIssuesSync --preview
ntn workers sync state reset granolaNotesDelta
ntn workers sync trigger granolaNotesDelta --preview
ntn workers sync state reset slackMessagesBackfill
ntn workers sync trigger slackMessagesBackfill --preview
ntn workers sync state reset slackMessagesDelta
ntn workers sync trigger slackMessagesDelta --preview
```
