# Shape Machine Demo Script

Shape Machine is a Notion-native engineering operating system for a product builder, engineering manager, or CTO at a small startup. It watches the tools where engineering work already happens, turns the signals into durable Notion memory, and routes risky actions through review.

## One-Sentence Pitch

Shape Machine is a Notion-native engineering command center that watches your tools, remembers what changed, and turns engineering signals into reviewed action.

## Judge Story

Small teams do not miss things because they lack dashboards. They miss things because production alerts, pull requests, Slack context, meeting notes, and docs all live in different systems. Shape Machine turns Notion into the operating layer for that work:

1. **Signals arrive** from GitHub, Sentry, Slack, Granola, and Markdown docs.
2. **Workers normalize them** through syncs, deltas, webhooks, and tools.
3. **Notion becomes the memory layer** with source links, owners, status, context, and next actions.
4. **The AI triage layer creates a test/action queue** for what should be reviewed, fixed, documented, or delegated to a coding agent.
5. **Risky actions require approval** by opening review artifacts such as GitHub pull requests instead of silently changing production.

## Three-Minute Demo

### 0:00-0:30 - Command Center

Open the Shape Machine Notion hub.

Show:

- Engineering Command Center
- Signal Inbox
- Incidents
- GitHub Work
- Meeting Action Items
- Engineering Wiki
- Daily Briefs
- Test and Action Queue

Say: "This is the CTO morning screen. It tells you what changed overnight, what needs attention, and what the agent can safely do next."

### 0:30-1:15 - Signals Become Memory

Open the synced data sources:

- GitHub Issues and PRs
- Sentry Issues
- Slack Messages
- Granola Notes

Show that every row has source identity, timestamps, links, and normalized properties. Open one GitHub or Sentry page and show the enriched page body.

Say: "The worker is not making another dashboard. It is creating durable operational memory inside Notion, where the team already plans and writes."

### 1:15-2:00 - Prioritized Test and Action Queue

Open the Test and Action Queue.

Show rows such as:

- `P0 - Sentry issue has no owner or rollback note`
- `P1 - Pull request stalled after review`
- `P1 - Meeting action item has no task`
- `P2 - Wiki page changed in Notion; open PR for review`
- `P2 - Draft EOD release note from merged PRs`

Say: "The AI reads the workspace context and classifies what needs human review, what can be delegated, and what should be turned into a coding-agent task."

### 2:00-2:40 - Approval-Gated Action

Run or show the Notion-to-GitHub docs flow:

```bash
ntn workers exec startupDocsNotionToGithub --local -d '{"pageId":"<notion-page-id>","dryRun":true}'
```

Then explain the live path:

- A Notion Wiki edit is received by `startupDocsNotionPageWebhook`.
- The Worker maps the page back to a Markdown file.
- It creates a branch and pull request.
- Humans review before merging.

Say: "This is the approval boundary. The agent can act, but production-facing docs and code still go through a PR."

### 2:40-3:00 - Close

Say: "Shape Machine gives small teams the operating discipline of a larger engineering org: morning briefs, incident memory, stale-work detection, meeting follow-through, release-note drafts, and coding-agent handoffs, all inside Notion."

## Backup CLI Commands

```bash
npm run demo:check
```

Expanded local checks:

```bash
npm run check
ntn doctor
ntn workers exec checkNotionConnection --local -d '{}'
ntn workers exec githubIssuesNotionBackfill --local -d '{"dryRun":true,"page":1,"updatedSince":null,"includeContext":false}'
ntn workers exec startupDocsGithubToNotion --local -d '{"dryRun":true,"paths":null,"ref":null}'
ntn workers exec startupDocsNotionToGithub --local -d '{"pageId":"<notion-page-id>","dryRun":true}'
```

Optional deployed-worker checks after remote env is pushed and the worker is deployed:

```bash
ntn workers sync trigger sentryIssuesSync --preview
ntn workers sync trigger granolaNotesDelta --preview
ntn workers sync trigger slackMessagesDelta --preview
```

## What To Avoid Showing

- Tokens, secrets, private customer data, or private incident details.
- Raw implementation setup before showing the product experience.
- A broad tour of every environment variable.
- Any claim that the Worker silently changes production code. It opens review artifacts.
