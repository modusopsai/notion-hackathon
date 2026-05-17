# Test and Action Queue

The Test and Action Queue is the product surface that turns Shape Machine from a set of integrations into an engineering operating system.

## Purpose

The queue gives a product builder, engineering manager, or CTO a prioritized list of what needs attention after Shape Machine reads GitHub, Sentry, Slack, Granola, and the Engineering Wiki.

It should answer:

- What broke?
- What is blocked?
- What can the coding agent safely attempt?
- What needs human approval?
- What should become a release note, task, or doc update?

## Prioritization

| Priority | Meaning | Example |
| --- | --- | --- |
| P0 | Production risk or customer-visible failure | Sentry issue has no owner, no rollback note, and rising events |
| P1 | Shipping or coordination blocker | PR is stale after review, Slack thread contains unresolved launch blocker |
| P2 | Follow-through gap | Meeting action item has no task, merged PR has no release note |
| P3 | Hygiene or improvement | Wiki page missing owner, old issue has stale labels |

## Action Types

| Action Type | Meaning | Example |
| --- | --- | --- |
| Monitor | Keep visible but do not act yet | Low-volume Sentry issue |
| Review | Needs a human decision | Ambiguous Slack request |
| Fix | Candidate for coding-agent PR | Small failing test or stale config |
| Document | Update the Wiki | Production workaround discussed in Slack |
| Communicate | Draft an external or internal message | EOD report or customer follow-up |

## Demo Seed Rows

Use these rows in Notion if live data is not clean enough for judging.

| Test | Priority | Signal | Action Type | Status | Agent Candidate | Approval Required | Acceptance Criteria |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sentry issue needs owner and rollback note | P0 | Sentry | Review | New | No | Yes | Incident page has owner, severity, source link, rollback note, and next action |
| Stalled pull request needs coding-agent follow-up | P1 | GitHub | Fix | Ready | Yes | Yes | Agent reads Wiki context, proposes a minimal PR, and links it back to the queue item |
| Meeting action item was never converted to work | P1 | Granola | Review | New | No | Yes | Action item has owner, due date, and related GitHub or Notion task |
| Slack launch thread should become release-note draft | P2 | Slack | Communicate | Ready | No | Yes | Draft release note includes source links and waits for approval before posting |
| Wiki page edited in Notion should open GitHub PR | P2 | Wiki | Document | Ready | Yes | Yes | Worker maps page to Markdown and opens a pull request instead of pushing to main |
| Morning engineering brief should include overnight deltas | P2 | Brief | Communicate | Ready | No | No | Brief includes incidents, stalled PRs, merged work, meetings, and next actions |
| EOD report should close the loop on shipped work | P2 | Brief | Communicate | Ready | No | No | Report includes shipped PRs, unresolved risks, docs changed, and tomorrow's carryover |

## Coding-Agent Handoff Contract

Small, bounded tasks can be delegated to a coding agent when all of these are true:

- The task has clear acceptance criteria.
- The relevant Wiki or GitHub context is linked.
- The change can be reviewed through a pull request.
- The blast radius is limited.
- Secrets or private customer data are not needed.

The agent should not directly post public updates, change production settings, or merge its own PR.
