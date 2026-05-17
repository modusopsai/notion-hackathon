#!/usr/bin/env bash
# End-to-end pipeline test: runs the four read tools, then calls createSynthesis
# with hand-crafted themes drawn from the real substrate. Lets you verify the
# full pipeline (read substrate → render synthesis page) without the agent.

set -euo pipefail

OUT_DIR=${OUT_DIR:-/tmp/notion-hackathon-test}
mkdir -p "$OUT_DIR"

echo "==> Reading GitHub activity (last 365 days, limit 30)"
ntn workers exec readGithubActivity --local -d '{"sinceDays": 365, "limit": 30, "types": null}' \
  > "$OUT_DIR/github.json"
echo "    saved to $OUT_DIR/github.json — totalReturned=$(grep -o '"totalReturned":[ ]*[0-9]*' "$OUT_DIR/github.json" | head -1 | tr -dc '0-9')"

echo "==> Reading Sentry issues (last 90 days, limit 50)"
ntn workers exec readSentryIssues --local -d '{"sinceDays": 90, "limit": 50, "levels": null}' \
  > "$OUT_DIR/sentry.json"
echo "    saved to $OUT_DIR/sentry.json — totalReturned=$(grep -o '"totalReturned":[ ]*[0-9]*' "$OUT_DIR/sentry.json" | head -1 | tr -dc '0-9')"

echo "==> Reading Granola notes (last 180 days, limit 30)"
ntn workers exec readGranolaNotes --local -d '{"sinceDays": 180, "limit": 30}' \
  > "$OUT_DIR/granola.json"
echo "    saved to $OUT_DIR/granola.json — totalReturned=$(grep -o '"totalReturned":[ ]*[0-9]*' "$OUT_DIR/granola.json" | head -1 | tr -dc '0-9')"

echo "==> Reading Slack messages (limit 100)"
ntn workers exec readSlackMessages --local -d '{"limit": 100}' \
  > "$OUT_DIR/slack.json"
echo "    saved to $OUT_DIR/slack.json — totalReturned=$(grep -o '"totalReturned":[ ]*[0-9]*' "$OUT_DIR/slack.json" | head -1 | tr -dc '0-9')"

echo ""
echo "==> Calling createSynthesis with hand-crafted themes"

# Themes/divergences below are hand-crafted from the shape of the data we saw
# in the last run. The Notion Custom Agent will do this clustering for real
# once it's wired up. For this test, we stub it to prove the pipeline works.
ntn workers exec createSynthesis --local -d '{
  "overview": "Production appears to be showing real user-facing pain (multiple unresolved Sentry issues with active users) while the synced GitHub repo shows little to no commit activity, which likely suggests dev work is happening in a different repo or the team has paused shipping into this codebase. The dominant Sentry pattern points at client-side DOM lifecycle bugs in the Next.js app, concentrated on /pricing, /orgs/:slug, and /login. Confidence is highest on the Sentry pattern and lowest on the dev/silence interpretation since the GitHub silence could have benign explanations.",
  "themes": [
    {
      "name": "Production DOM lifecycle bugs",
      "type": "fix",
      "summary": "Three distinct client-side errors (parentNode, removeChild, removeListener) appear together in Sentry, all on Next.js pages with high traffic. This pattern likely suggests React hydration or cleanup issues rather than three independent bugs.",
      "confidence": 0.75,
      "confidenceReasoning": "0.75 — strong Sentry signal (three related error types, recurring, multiple users) but the cluster is inferred from error similarity, not stated by anyone. No GitHub or Granola signal to corroborate or refute.",
      "momentum": "steady",
      "stakeholders": null,
      "sources": {
        "github": null,
        "sentry": ["TypeError: Cannot read properties of null (reading parentNode) on /news/:slug (1 user, 6 events)", "NotFoundError: removeChild on /orgs/:slug (2 users, 3 events)", "TypeError: removeListener on /pricing (5 users, 5 events)"],
        "granola": null,
        "slack": null
      },
      "insight": "Three React-shaped errors clustered on different routes. Likely one shared root cause (hydration or effect cleanup) rather than three separate bugs.",
      "openQuestions": [
        "Possibly all three trace to a common Next.js upgrade or hydration boundary; would confirm by checking which release introduced them.",
        "Likely the /pricing error has the highest user impact (5 users); would confirm by checking session replay links in Sentry."
      ],
      "counterEvidence": null
    },
    {
      "name": "Payment / pricing page fragility",
      "type": "fix",
      "summary": "The /pricing route surfaces in multiple Sentry issues affecting 5+ users each. Either the page is genuinely fragile or it just has the most traffic, but the cluster is notable.",
      "confidence": 0.6,
      "confidenceReasoning": "0.6 — Sentry signal is real but ambiguous: /pricing could be over-represented because it gets more traffic, not because it is buggier. No revenue impact data to confirm.",
      "momentum": "rising",
      "stakeholders": null,
      "sources": {
        "github": null,
        "sentry": ["TypeError: Failed to fetch on /pricing (5 users, 14 events, ongoing)", "TypeError: removeListener on /pricing (5 users, 5 events)"],
        "granola": null,
        "slack": null
      },
      "insight": "Both errors fire on the same route with the same user count. Possibly the same session population hits both. Worth a session replay review.",
      "openQuestions": [
        "Possibly these are downstream of the DOM lifecycle pattern above; would confirm by cross-referencing the release SHAs."
      ],
      "counterEvidence": null
    },
    {
      "name": "Browser extension / CSP noise",
      "type": "polish",
      "summary": "One Sentry issue about CSP blocking WebAssembly, traced to /inject.js — likely a browser extension trying to inject WASM, not application code.",
      "confidence": 0.85,
      "confidenceReasoning": "0.85 — high confidence this is third-party noise. The filename /inject.js and the user-agent pattern strongly suggest a Chrome extension. Worth suppressing in Sentry rather than fixing.",
      "momentum": "dormant",
      "stakeholders": null,
      "sources": {
        "github": null,
        "sentry": ["CompileError: WebAssembly violates CSP on /orgs/:slug (1 user, 3 events)"],
        "granola": null,
        "slack": null
      },
      "insight": "Not application work. Best handled by tightening the Sentry inbound filter so it stops drawing attention away from real bugs.",
      "openQuestions": null,
      "counterEvidence": null
    }
  ],
  "divergences": [
    {
      "observation": "Sentry shows active production issues but the synced GitHub repo has zero events in the lookback window.",
      "sources": ["Sentry", "GitHub"],
      "hypothesis": "Possibly the actual product repo is different from modusopsai/notion-hackathon (the configured GitHub source), or the GitHub sync itself has stopped fetching.",
      "whatToCheck": "Worth confirming which repo backs startupintros.com and whether the githubActivitySync is healthy in `ntn workers sync status`."
    },
    {
      "observation": "Granola notes exist but no theme above references them; meetings appear disconnected from the operational pain Sentry is surfacing.",
      "sources": ["Granola", "Sentry"],
      "hypothesis": "Possibly the meetings cover other topics (sales, strategy) and bugs are not being discussed, or the bugs are too new to have surfaced yet.",
      "whatToCheck": "Worth scanning the Granola summaries for any /pricing, /orgs, or hydration mentions and flagging if absent."
    },
    {
      "observation": "Slack has 139 recent messages but no theme above references them; channel signal isn'\''t tied to the Sentry pattern.",
      "sources": ["Slack", "Sentry"],
      "hypothesis": "Possibly the relevant engineering channel was not synced, or the team triages bugs in a tracker rather than chat.",
      "whatToCheck": "Worth checking which Slack channels are connected and whether an engineering or oncall channel is among them."
    }
  ],
  "title": "Synthesis Test - end-to-end pipeline check",
  "windowDescription": "the substrate available in this run (mixed windows per source)"
}'
echo ""
echo "==> Done. Open the page URL printed above to inspect the rendered synthesis."
