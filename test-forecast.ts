// Smoke test for the createSynthesis tool's heaven/hell forecast section.
//
// Builds a representative payload and runs it through `ntn workers exec
// createSynthesis --local`, which uses the .env in this directory for
// NOTION_API_TOKEN and SYNTHESIS_PARENT_PAGE_ID.
//
// Run with: npx tsx test-forecast.ts
//
// On success, prints the URL of the created Notion page. Open it and
// verify the new forecast section renders: dramatic epigraph banner,
// snapshot callout, mermaid fork diagram, fork to-dos, then the full
// hell/heaven columns at the bottom.

import { execSync } from "node:child_process";

const payload = {
	// Omit `title` so the worker's default ("Two Roads — May 17, 2026") kicks in.
	title: null,
	windowDescription: "the last six weeks (synthetic test data)",
	overview:
		"Across the last six weeks, three workstreams are loud and one is quiet. The auth refactor appears to be moving but the SSO question keeps resurfacing without a written decision. The admin dashboard is mentioned often but appears nowhere in code. Sentry noise from the OAuth migration has climbed steadily with no commits addressing it.",
	themes: [
		{
			name: "Auth refactor",
			type: "refactor",
			summary:
				"Single-author commit activity on /auth, no written spec, two meetings discussed SSO without recorded outcomes.",
			confidence: 0.78,
			confidenceReasoning:
				"0.78 — strong GitHub signal (6 commits, one author) plus two Granola mentions; Slack shows debate but no decision artifact.",
			momentum: "steady",
			stakeholders: ["Alex"],
			sources: {
				github: [
					"abc1234: refactor OAuth callback (alex)",
					"def5678: extract token validator (alex)",
				],
				sentry: ["OAuth callback timeout (12 events, P2)"],
				granola: ["Mon standup: SSO question raised, no decision"],
				slack: ["#eng-auth: 4 messages this week mentioning SSO"],
				wiki: [
					"Feature Spec: Onboarding and Checkout (Draft) — references SSO behavior but no decision recorded in the spec",
					"ADR 0001: Use Supabase Session Pooler (Published) — establishes the session pattern this refactor should honor",
				],
			},
			insight:
				"Engineering appears to be driving this alone — the lack of a written spec and the recurring SSO debate suggest scope ambiguity that will likely surface as rework if not addressed.",
			openQuestions: [
				"Possibly the SSO question requires a product call, not an eng decision — would confirm by checking who's expected to own the call.",
			],
			counterEvidence: null,
		},
		{
			name: "Admin dashboard",
			type: "feature",
			summary:
				"Mentioned in three meetings and one Slack thread; no commits or design docs surface this work.",
			confidence: 0.42,
			confidenceReasoning:
				"0.42 — Granola and Slack reinforce; GitHub and Sentry are silent, so this is intent without execution.",
			momentum: "emerging",
			stakeholders: null,
			sources: {
				github: null,
				sentry: null,
				granola: [
					"Tue planning: admin dashboard discussed as Q3 candidate",
					"Wed sync: admin dashboard flagged as priority",
				],
				slack: ["#product: thread about admin dashboard scope"],
				wiki: [
					"Feature Spec: Workspace Dashboard (Draft) — overlaps in scope with the admin dashboard discussion; no explicit linkage",
				],
			},
			insight: null,
			openQuestions: [
				"Likely no owner has been assigned; worth checking whether anyone has been told this is their work.",
			],
			counterEvidence: null,
		},
	],
	divergences: [
		{
			observation:
				"Admin dashboard is mentioned in three meetings but appears nowhere in code or design docs.",
			sources: ["Granola", "GitHub"],
			hypothesis:
				"Possibly because the work was discussed but never formally assigned an owner.",
			whatToCheck:
				"Worth confirming with @alice whether admin dashboard is committed for this quarter.",
		},
		{
			observation:
				"Sentry OAuth callback errors have climbed 18% since May 1st but no commits address them.",
			sources: ["Sentry", "GitHub"],
			hypothesis: null,
			whatToCheck:
				"Worth asking whether the OAuth migration team is tracking these.",
		},
		{
			observation:
				"Runbook: Sentry Triage defines a clear response path for error climbs, but the observed behavior on the May OAuth climb does not follow it (no triage ticket, no owner assignment).",
			sources: ["Wiki", "Sentry", "GitHub"],
			hypothesis:
				"Possibly the runbook is not surfaced in oncall onboarding, or the climb didn't cross the alerting threshold the runbook expects.",
			whatToCheck:
				"Worth confirming whether oncall knows the runbook exists and what triggered (or didn't trigger) the page.",
		},
	],
	forecast: {
		dramaticEpigraph:
			"From this snapshot, two futures unfold. One requires nothing of you. The other requires a Tuesday meeting.",
		snapshot:
			"Across the last six weeks, three workstreams are loud and one is quiet. The auth refactor is moving — six commits, all from Alex, no written spec, two meetings with no recorded SSO decision. The billing migration is steady, two engineers, well-scoped. The admin dashboard has been mentioned in three meetings and one Slack thread but appears nowhere in code. Sentry noise from the OAuth migration has climbed 18% since May 1st with no commits addressing it.",
		mischievousReading: [
			"Tuesday's PR review goes about how you'd expect — five reviewers added, two real comments, three thumbs-ups, and Alex merges Friday at 6pm to escape the SSO question for one more week. The admin dashboard surfaces in another meeting where everyone agrees it's important; no one opens a doc. The Sentry numbers climb another 12% and someone notices on Wednesday; the thread will go quiet by Thursday.",
			"By August the auth refactor has become a 4,000-line branch with the spectral quality of a haunted house — Alex maintains it alone, occasionally muttering, while the rest of the team gives it a wide berth. The SSO question gets relitigated in late July and again in early August because nobody can find what was decided. The admin dashboard is still mentioned in meetings. Still nowhere in code. The Sentry alerts have gone quiet because someone raised the threshold.",
			"By year-end the auth refactor exists across four parallel branches, none of which can be merged with the others. Alex has been promoted, partly for resilience. The admin dashboard has achieved a kind of folkloric status — referenced often, glimpsed never. The team has stopped saying its name. The retro slide deck contains the word learnings nineteen times. I'll be there. I always am.",
		].join("\n\n"),
		radiantReading: [
			"Tuesday's 30-minute decision meeting closes the SSO question with a one-page ADR. Alex's PR lands clean on Thursday with three substantive reviews. The admin dashboard gets a named owner and a one-pager by Friday — the first paragraph alone surfaces two scope questions that would have otherwise eaten weeks. Someone catches the May Sentry climb on Monday; the fix ships Wednesday.",
			"By August the auth refactor has shipped in three reviewable PRs with linked ADRs that future engineers quietly bless on their way in. The admin dashboard's first version lands in July, deliberately small, and the team's appetite for incremental shipping subtly recalibrates around it. The Sentry numbers are flat. The team's retro mentions specific decisions by name.",
			"By year-end the codebase reads like scripture. New engineers report a strange peace on their first day. The team's ADRs are passed around at conferences in lowered voices. The admin dashboard is loved. The retro slide deck contains the word decided nineteen times. Velocity charts have become unfashionable; the team tracks outcomes.",
		].join("\n\n"),
		fork: [
			{
				action: "Land an SSO decision with a written ADR",
				owner: "Alex + Priya",
				timing: "by Tuesday EOD",
			},
			{
				action: "Break the auth refactor into reviewable PRs with ADRs",
				owner: "Alex",
				timing: "over the next three weeks",
			},
			{
				action: "Assign an owner and write a one-pager for the admin dashboard",
				owner: "needs an owner",
				timing: "by Friday",
			},
			{
				action: "Take explicit ownership of the May Sentry OAuth climb",
				owner: "needs an owner",
				timing: "this week",
			},
		],
		mischievousImageUrl: null,
		radiantImageUrl: null,
	},
};

const json = JSON.stringify(payload);
// Escape single quotes for safe inclusion in a single-quoted shell argument.
const shellSafe = json.replace(/'/g, "'\\''");

console.log("Calling createSynthesis with smoke-test payload...\n");

try {
	const output = execSync(
		`ntn workers exec createSynthesis --local -d '${shellSafe}'`,
		{ encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] },
	);
	console.log(output);
	console.log("\n✅ Smoke test complete. Open the URL above to verify the rendered page.");
} catch (err) {
	const e = err as { stdout?: string; stderr?: string; message: string };
	console.error("❌ Smoke test failed:\n");
	if (e.stdout) console.error("stdout:\n", e.stdout);
	if (e.stderr) console.error("stderr:\n", e.stderr);
	console.error("\n", e.message);
	process.exit(1);
}
