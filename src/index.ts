import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	Worker,
	RateLimitError,
	WebhookVerificationError,
} from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import type { TextValue } from "@notionhq/workers/types";
import { isFullBlock } from "@notionhq/client";
import type { BlockObjectRequest, Client } from "@notionhq/client";

const worker = new Worker();
export default worker;

const GITHUB_OWNER_DEFAULT = "modusopsai";
const GITHUB_REPO_DEFAULT = "notion-hackathon";
const GITHUB_EVENTS_PAGE_SIZE = 100;
const GITHUB_ISSUES_PAGE_SIZE = 100;
const GITHUB_DELTA_BUFFER_MS = 60_000;
const GITHUB_NOTION_DATA_SOURCE_ID_DEFAULT =
	"3623edae28d380cdafa7000b11385255";
const GITHUB_CONTEXT_COMMENTS_LIMIT = 10;
const GITHUB_CONTEXT_FILES_LIMIT = 50;
const GITHUB_CONTEXT_COMMITS_LIMIT = 20;
const GITHUB_CONTEXT_REVIEWS_LIMIT = 20;
const STARTUP_DOCS_OWNER_DEFAULT = "StartupIntros";
const STARTUP_DOCS_REPO_DEFAULT = "startupintros-nextjs";
const STARTUP_DOCS_BRANCH_DEFAULT = "main";
const STARTUP_DOCS_NOTION_DATA_SOURCE_ID_DEFAULT =
	"3633edae-28d3-8028-b316-000bc8522720";
const STARTUP_DOCS_RELATED_PROPERTY = "Related Wiki Pages";
const GRANOLA_PAGE_SIZE = 30;
const GRANOLA_DELTA_BUFFER_MS = 60_000;
const GRANOLA_NOTION_DATA_SOURCE_ID_DEFAULT =
	"3623edae-28d3-8095-958c-000b712611af";
const SLACK_HISTORY_PAGE_SIZE = 15;
const SLACK_DELTA_BUFFER_MS = 60_000;
// The company Wiki database lives natively in Notion (not synced by this
// worker). The readWiki tool queries it directly so the Custom Agent can
// compare documented intent (PRDs, Feature Specs, ADRs, Runbooks) against
// observed execution (commits, errors, meetings, messages).
const WIKI_NOTION_DATA_SOURCE_ID_DEFAULT =
	"3633edae-28d3-8028-b316-000bc8522720";

const githubApi = worker.pacer("githubApi", {
	allowedRequests: 10,
	intervalMs: 1000,
});

const sentryApi = worker.pacer("sentryApi", {
	allowedRequests: 5,
	intervalMs: 1000,
});

const granolaApi = worker.pacer("granolaApi", {
	allowedRequests: 5,
	intervalMs: 1000,
});

const slackApi = worker.pacer("slackApi", {
	allowedRequests: readIntegerEnv("SLACK_REQUESTS_PER_MINUTE", 1, 1, 50),
	intervalMs: 60_000,
});

const githubActivity = worker.database("githubActivity", {
	type: "managed",
	initialTitle: "GitHub Activity",
	primaryKeyProperty: "GitHub Event ID",
	schema: {
		properties: {
			Activity: Schema.title(),
			"GitHub Event ID": Schema.richText(),
			Type: Schema.richText(),
			Actor: Schema.richText(),
			Repo: Schema.richText(),
			"Branch/Ref": Schema.richText(),
			"Payload Summary": Schema.richText(),
			"Created Time": Schema.date(),
			URL: Schema.url(),
			"Raw JSON": Schema.richText(),
		},
	},
});

const githubIssues = worker.database("githubIssues", {
	type: "managed",
	initialTitle: "GitHub Issues and PRs",
	primaryKeyProperty: "GitHub Item ID",
	schema: {
		properties: {
			Title: Schema.title(),
			"GitHub Item ID": Schema.richText(),
			Number: Schema.number("number"),
			Type: Schema.richText(),
			State: Schema.richText(),
			"State Reason": Schema.richText(),
			Author: Schema.richText(),
			Assignees: Schema.richText(),
			Labels: Schema.richText(),
			Milestone: Schema.richText(),
			Comments: Schema.number("number"),
			Locked: Schema.checkbox(),
			"Created Time": Schema.date(),
			"Updated Time": Schema.date(),
			"Closed Time": Schema.date(),
			URL: Schema.url(),
			"Repo Full Name": Schema.richText(),
		},
	},
});

const sentryIssues = worker.database("sentryIssues", {
	type: "managed",
	initialTitle: "Sentry Issues",
	primaryKeyProperty: "Sentry Issue ID",
	schema: {
		properties: {
			Issue: Schema.title(),
			"Sentry Issue ID": Schema.richText(),
			Culprit: Schema.richText(),
			Level: Schema.richText(),
			Status: Schema.richText(),
			Project: Schema.richText(),
			"User Count": Schema.number("number_with_commas"),
			"Event Count": Schema.number("number_with_commas"),
			"First Seen": Schema.date(),
			"Last Seen": Schema.date(),
			Permalink: Schema.url(),
		},
	},
});

const granolaNotes = worker.database("granolaNotes", {
	type: "managed",
	initialTitle: "Granola Notes",
	primaryKeyProperty: "Granola Note ID",
	schema: {
		properties: {
			Note: Schema.title(),
			"Granola Note ID": Schema.richText(),
			Owner: Schema.richText(),
			Attendees: Schema.richText(),
			"Meeting Time": Schema.date(),
			Summary: Schema.richText(),
			"Action Items": Schema.richText(),
			"Updated Time": Schema.date(),
			"Web URL": Schema.url(),
		},
	},
});

const slackMessages = worker.database("slackMessages", {
	type: "managed",
	initialTitle: "Slack Messages",
	primaryKeyProperty: "Slack Message ID",
	schema: {
		properties: {
			Message: Schema.title(),
			"Slack Message ID": Schema.richText(),
			"Channel ID": Schema.richText(),
			"Channel Name": Schema.richText(),
			User: Schema.richText(),
			"Bot ID": Schema.richText(),
			Type: Schema.richText(),
			Subtype: Schema.richText(),
			Text: Schema.richText(),
			"Message Time": Schema.date(),
			"Thread TS": Schema.richText(),
			"Reply Count": Schema.number("number"),
			"Edited Time": Schema.date(),
			"Raw JSON": Schema.richText(),
		},
	},
});

worker.tool("checkNotionConnection", {
	title: "Check Notion Connection",
	description: "Verify that NOTION_API_TOKEN can authenticate with the Notion API",
	schema: j.object({}),
	execute: async (_input, { notion }) => {
		const token = requireEnv("NOTION_API_TOKEN");
		const search = await notion.search({ auth: token, page_size: 1 });

		return {
			ok: true,
			visibleResults: search.results.length,
			hasMore: search.has_more,
		};
	},
});

worker.tool<StartupDocsGithubToNotionInput>("startupDocsGithubToNotion", {
	title: "Sync Startup Docs From GitHub to Notion",
	description:
		"Backfill or update Startup Intros Markdown documentation from GitHub into the existing Wiki data source.",
	schema: j.object({
		dryRun: j
			.boolean()
			.nullable()
			.describe("When true, list matching Markdown files without writing."),
		paths: j
			.string()
			.nullable()
			.describe(
				"Optional comma-separated repo paths to sync. Defaults to every configured documentation Markdown path.",
			),
		ref: j
			.string()
			.nullable()
			.describe("Optional Git ref or branch. Defaults to STARTUP_DOCS_BRANCH or main."),
	}),
	execute: async (input, { notion }) => {
		const dryRun = input.dryRun ?? false;
		const ref = input.ref ?? startupDocsBranch();
		const paths =
			parseCsv(input.paths ?? "").length > 0
				? parseCsv(input.paths ?? "").filter(isStartupDocsPath)
				: await listStartupDocsMarkdownPaths(ref);

		if (dryRun) {
			return {
				dryRun,
				ref,
				count: paths.length,
				upserted: 0,
				paths,
			};
		}

		const notionClient = notion as unknown as NotionClientLike;
		const auth = startupDocsNotionAuth();
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			startupDocsNotionTargetId(),
		);
		const schema = await ensureStartupDocsNotionSchema(
			notionClient,
			auth,
			dataSourceId,
		);

		let upserted = 0;
		for (const path of paths) {
			const file = await fetchStartupDocsGithubFile(path, ref);
			await upsertStartupDocsNotionPage(
				notionClient,
				auth,
				dataSourceId,
				schema,
				file,
				"manual-github-backfill",
			);
			upserted += 1;
		}

		return {
			dryRun,
			ref,
			count: paths.length,
			upserted,
			paths,
		};
	},
});

worker.tool<StartupDocsNotionToGithubInput>("startupDocsNotionToGithub", {
	title: "Open Startup Docs PR From Notion Page",
	description:
		"Create a GitHub pull request from one uploaded Startup Intros Wiki page back to its Markdown file.",
	schema: j.object({
		pageId: j.string().describe("Notion page ID to export back to GitHub."),
		dryRun: j
			.boolean()
			.nullable()
			.describe("When true, retrieve and map the page without creating a branch or PR."),
	}),
	execute: async (input, { notion }) => {
		const notionClient = notion as unknown as NotionClientLike;
		const auth = startupDocsNotionAuth();
		const result = await syncStartupDocsNotionPageToGithub(
			notionClient,
			auth,
			input.pageId,
			input.dryRun ?? false,
			"manual-notion-export",
		);

		return result;
	},
});

worker.tool<GithubIssuesNotionBackfillInput>("githubIssuesNotionBackfill", {
	title: "Backfill GitHub Issues to Notion",
	description:
		"Fetch one page of GitHub issues and pull requests and upsert them into the configured existing Notion database.",
	schema: j.object({
		dryRun: j
			.boolean()
			.nullable()
			.describe("When true, fetch and map data without writing to Notion."),
		page: j
			.integer()
			.nullable()
			.describe("GitHub REST page number to fetch. Defaults to 1."),
		updatedSince: j
			.string()
			.nullable()
			.describe("Optional ISO timestamp for GitHub's since filter."),
		includeContext: j
			.boolean()
			.nullable()
			.describe(
				"When true or omitted, fetch issue/PR body, comments, and pull request context before writing.",
			),
	}),
	execute: async (input, { notion }) => {
		const page = input.page ?? 1;
		const dryRun = input.dryRun ?? false;
		const includeContext = input.includeContext ?? true;
		const { issues, hasMore } = await fetchGithubIssuesPage({
			page,
			updatedSince: input.updatedSince ?? undefined,
			usePacer: false,
		});
		const enrichedIssues = includeContext
			? await enrichGithubIssues(issues, { usePacer: false })
			: issues.map((issue) => ({ issue }));

		if (dryRun) {
			return {
				dryRun,
				fetched: issues.length,
				upserted: 0,
				skipped: issues.length,
				hasMore,
				nextInput: hasMore
					? {
							dryRun,
							page: page + 1,
							updatedSince: input.updatedSince,
							includeContext,
						}
					: null,
				sample: enrichedIssues[0]
					? githubIssueNotionPreview(enrichedIssues[0])
					: null,
			};
		}

		const notionClient = notion as unknown as NotionClientLike;
		const auth = githubNotionAuth();
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			githubNotionTargetId(),
		);
		const schema = await ensureGithubNotionSchema(
			notionClient,
			auth,
			dataSourceId,
		);

		let upserted = 0;
		for (const issue of enrichedIssues) {
			await upsertGithubIssuePage(notionClient, auth, dataSourceId, issue, schema);
			upserted += 1;
		}

		return {
			dryRun,
			fetched: issues.length,
			upserted,
			skipped: 0,
			hasMore,
			nextInput: hasMore
				? {
						dryRun,
						page: page + 1,
						updatedSince: input.updatedSince,
						includeContext,
					}
				: null,
			sample: null,
		};
	},
});

type GithubSyncState = {
	seenEventIds?: string[];
};

type GithubIssuesBackfillState = {
	page?: number;
};

type GithubIssuesDeltaState = {
	updatedSince?: string;
	page?: number;
	cycleMaxUpdatedAt?: string;
};

type GithubIssuesNotionBackfillInput = {
	dryRun: boolean | null;
	page: number | null;
	updatedSince: string | null;
	includeContext: boolean | null;
};

type StartupDocsGithubToNotionInput = {
	dryRun: boolean | null;
	paths: string | null;
	ref: string | null;
};

type StartupDocsNotionToGithubInput = {
	pageId: string;
	dryRun: boolean | null;
};

type StartupDocsGithubFile = {
	path: string;
	sha: string;
	htmlUrl: string;
	content: string;
	ref: string;
};

type GitHubPushWebhookPayload = {
	ref?: string;
	after?: string;
	deleted?: boolean;
	repository?: {
		name?: string;
		full_name?: string;
		default_branch?: string;
		owner?: {
			name?: string;
			login?: string;
		};
	};
	commits?: Array<{
		added?: string[];
		modified?: string[];
		removed?: string[];
	}>;
};

type NotionPageWebhookPayload = {
	type?: string;
	entity?: {
		id?: string;
		type?: string;
	};
	data?: {
		id?: string;
		parent?: {
			data_source_id?: string;
			database_id?: string;
		};
		updated_blocks?: Array<{
			id?: string;
			type?: string;
		}>;
	};
};

type SentrySyncState = {
	cursor?: string;
};

type GranolaBackfillState = {
	cursor?: string;
};

type GranolaDeltaState = {
	updatedAfter?: string;
	cursor?: string;
	cycleMaxUpdatedAt?: string;
};

type SlackBackfillState = {
	channelIndex?: number;
	cursor?: string;
};

type SlackDeltaState = {
	channelIndex?: number;
	cursor?: string;
	oldest?: string;
	cycleMaxTs?: string;
};

type JsonRecord = Record<string, unknown>;

type GitHubEvent = {
	id: string;
	type: string;
	actor?: {
		login?: string;
		display_login?: string;
	};
	repo?: {
		name?: string;
		url?: string;
	};
	payload?: JsonRecord;
	public?: boolean;
	created_at?: string;
};

type GitHubIssue = {
	id: number;
	node_id?: string;
	number: number;
	title?: string;
	body?: string | null;
	state?: string;
	state_reason?: string | null;
	html_url?: string;
	comments?: number;
	locked?: boolean;
	created_at?: string;
	updated_at?: string;
	closed_at?: string | null;
	user?: {
		login?: string;
	};
	assignees?: Array<{
		login?: string;
	}>;
	labels?: Array<
		| string
		| {
				name?: string;
		  }
	>;
	milestone?: {
		title?: string;
	};
	pull_request?: {
		html_url?: string;
	};
};

type GitHubPullRequest = GitHubIssue & {
	merged?: boolean;
	draft?: boolean;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	mergeable_state?: string | null;
};

type GitHubIssueComment = {
	id?: number;
	html_url?: string;
	body?: string | null;
	created_at?: string;
	updated_at?: string;
	user?: {
		login?: string;
	};
};

type GitHubPullRequestReview = {
	id?: number;
	html_url?: string;
	state?: string;
	body?: string | null;
	submitted_at?: string;
	user?: {
		login?: string;
	};
};

type GitHubPullRequestFile = {
	filename?: string;
	status?: string;
	additions?: number;
	deletions?: number;
	changes?: number;
	blob_url?: string;
};

type GitHubPullRequestCommit = {
	sha?: string;
	html_url?: string;
	commit?: {
		message?: string;
		author?: {
			name?: string;
			date?: string;
		};
	};
	author?: {
		login?: string;
	};
};

type GitHubIssueContext = {
	detail?: GitHubIssue;
	comments: GitHubIssueComment[];
	pullRequest?: GitHubPullRequest;
	reviews: GitHubPullRequestReview[];
	files: GitHubPullRequestFile[];
	commits: GitHubPullRequestCommit[];
	syncedAt: string;
};

type EnrichedGitHubIssue = {
	issue: GitHubIssue;
	context?: GitHubIssueContext;
};

type GitHubWebhookPayload = {
	action?: string;
	issue?: GitHubIssue;
	pull_request?: GitHubIssue;
	repository?: {
		full_name?: string;
		owner?: {
			login?: string;
		};
		name?: string;
	};
};

type SentryIssue = {
	id: string;
	title?: string;
	culprit?: string;
	level?: string;
	status?: string;
	project?: {
		slug?: string;
		name?: string;
	};
	count?: string | number;
	userCount?: string | number;
	firstSeen?: string;
	lastSeen?: string;
	permalink?: string;
};

type SentryTag = {
	key?: string;
	value?: string;
};

type SentryStackFrame = {
	filename?: string;
	absPath?: string;
	function?: string;
	module?: string;
	lineno?: number;
	colno?: number;
	inApp?: boolean;
};

type SentryEvent = {
	id?: string;
	eventID?: string;
	title?: string;
	message?: string;
	platform?: string;
	type?: string;
	culprit?: string;
	location?: string | null;
	dateCreated?: string;
	dateReceived?: string;
	timestamp?: string;
	release?: string;
	tags?: SentryTag[];
	user?: JsonRecord | null;
	context?: JsonRecord;
	contexts?: JsonRecord;
	metadata?: JsonRecord | null;
	entries?: Array<{
		type?: string;
		data?: JsonRecord;
	}>;
};

type SentryDebugContext = {
	environment?: string;
	release?: string;
	transaction?: string;
	platform?: string;
	browser?: string;
	os?: string;
	runtime?: string;
	latestEventId?: string;
	latestEventTime?: string;
	location?: string;
	topStackFrame?: string;
	tags?: string;
	user?: string;
	contextSummary?: string;
	rawContext?: JsonRecord;
};

type EnrichedSentryIssue = NormalizedSentryIssue & {
	debug?: SentryDebugContext;
};

type NormalizedSentryIssue = Required<Pick<SentryIssue, "id">> &
	Omit<SentryIssue, "id">;

type GranolaListNote = {
	id: string;
	title: string | null;
	owner?: Person;
	created_at: string;
	updated_at: string;
};

type Person = {
	name?: string | null;
	email?: string | null;
};

type GranolaNote = GranolaListNote & {
	web_url?: string | null;
	calendar_event?: {
		event_title?: string | null;
		scheduled_start_time?: string | null;
		scheduled_end_time?: string | null;
		invitees?: Person[];
		organiser?: string | null;
	};
	attendees?: Person[];
	folder_membership?: Array<{
		name?: string | null;
	}>;
	summary_text?: string | null;
	summary_markdown?: string | null;
	transcript?: unknown[] | null;
};

type SlackMessage = {
	type?: string;
	subtype?: string;
	user?: string;
	username?: string;
	bot_id?: string;
	text?: string;
	ts: string;
	thread_ts?: string;
	reply_count?: number;
	edited?: {
		ts?: string;
		user?: string;
	};
};

type SlackHistoryResponse = {
	ok: boolean;
	error?: string;
	messages?: SlackMessage[];
	has_more?: boolean;
	response_metadata?: {
		next_cursor?: string;
	};
};

worker.sync("githubActivitySync", {
	database: githubActivity,
	mode: "incremental",
	schedule: "15m",
	execute: async (state: GithubSyncState | undefined) => {
		const owner = process.env.GITHUB_OWNER ?? GITHUB_OWNER_DEFAULT;
		const repo = process.env.GITHUB_REPO ?? GITHUB_REPO_DEFAULT;
		const token = requireEnv("GITHUB_TOKEN");

		await githubApi.wait();
		const events = await fetchJson<GitHubEvent[]>(
			`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/events?per_page=${GITHUB_EVENTS_PAGE_SIZE}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
			"GitHub repository events",
		);

		const previousIds = new Set(state?.seenEventIds ?? []);
		const changes = events
			.filter((event) => !previousIds.has(event.id))
			.map((event) => ({
				type: "upsert" as const,
				key: event.id,
				properties: {
					Activity: Builder.title(formatGithubActivityTitle(event)),
					"GitHub Event ID": Builder.richText(event.id),
					Type: Builder.richText(event.type),
					Actor: Builder.richText(formatActor(event.actor)),
					Repo: Builder.richText(event.repo?.name ?? `${owner}/${repo}`),
					"Branch/Ref": Builder.richText(formatGitRef(event.payload)),
					"Payload Summary": Builder.richText(formatGithubPayload(event)),
					"Created Time": dateTimeOrEmpty(event.created_at),
					URL: urlOrEmpty(getGithubEventUrl(event, owner, repo)),
					"Raw JSON": Builder.richText(toBoundedJson(event)),
				},
				upstreamUpdatedAt: event.created_at,
				pageContentMarkdown: githubEventMarkdown(event, owner, repo),
			}));

		return {
			changes,
			hasMore: false,
			nextState: {
				seenEventIds: events.map((event) => event.id).slice(0, GITHUB_EVENTS_PAGE_SIZE),
			},
		};
	},
});

worker.sync("githubIssuesBackfill", {
	database: githubIssues,
	mode: "replace",
	schedule: "manual",
	execute: async (state: GithubIssuesBackfillState | undefined) => {
		const page = state?.page ?? 1;
		const { issues, hasMore } = await fetchGithubIssuesPage({
			page,
		});

		return {
			changes: issues.map(githubIssueChange),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});

worker.sync("githubIssuesDelta", {
	database: githubIssues,
	mode: "incremental",
	schedule: "5m",
	execute: async (state: GithubIssuesDeltaState | undefined) => {
		const updatedSince =
			state?.updatedSince ?? bufferedGithubDeltaCursor(new Date());
		const page = state?.page ?? 1;
		const { issues, hasMore } = await fetchGithubIssuesPage({
			page,
			updatedSince,
		});
		const cycleMaxUpdatedAt = maxIsoDate(
			state?.cycleMaxUpdatedAt,
			...issues.map((issue) => issue.updated_at),
		);

		return {
			changes: issues.map(githubIssueChange),
			hasMore,
			nextState: hasMore
				? {
						updatedSince,
						page: page + 1,
						cycleMaxUpdatedAt,
					}
				: {
						updatedSince: nextGithubDeltaCursor(
							updatedSince,
							cycleMaxUpdatedAt,
						),
					},
		};
	},
});

worker.webhook("githubIssuesWebhook", {
	title: "GitHub Issues and Pull Requests Webhook",
	description:
		"Receives verified GitHub issue and pull request webhook deliveries and upserts them into the configured existing Notion database.",
	execute: async (events, { notion }) => {
		const secret = requireEnv("GITHUB_WEBHOOK_SECRET");
		const auth = githubNotionAuth();
		const notionClient = notion as unknown as NotionClientLike;
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			githubNotionTargetId(),
		);
		const schema = await ensureGithubNotionSchema(
			notionClient,
			auth,
			dataSourceId,
		);

		for (const event of events) {
			verifyGithubWebhookSignature(event.rawBody, event.headers, secret);

			const payload = objectValue(event.body) as GitHubWebhookPayload | undefined;
			const issue = normalizeGithubWebhookIssue(payload);
			if (!issue) {
				console.log(
					`Ignoring GitHub webhook ${event.deliveryId}: no issue or pull_request payload found.`,
				);
				continue;
			}

			if (payload?.action === "deleted") {
				await archiveGithubIssuePage(notionClient, auth, dataSourceId, issue);
				continue;
			}

			await upsertGithubIssuePage(
				notionClient,
				auth,
				dataSourceId,
				await enrichGithubIssue(issue, { usePacer: false }),
				schema,
			);
		}
	},
});

worker.webhook("startupDocsGithubPushWebhook", {
	title: "Startup Docs GitHub Push Webhook",
	description:
		"Receives verified GitHub push deliveries and syncs changed Markdown docs into the Startup Intros Notion Wiki.",
	execute: async (events, { notion }) => {
		const secret = startupDocsGithubWebhookSecret();
		const notionClient = notion as unknown as NotionClientLike;
		const auth = startupDocsNotionAuth();
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			startupDocsNotionTargetId(),
		);
		const schema = await ensureStartupDocsNotionSchema(
			notionClient,
			auth,
			dataSourceId,
		);

		for (const event of events) {
			verifyGithubWebhookSignature(event.rawBody, event.headers, secret);
			const payload = objectValue(event.body) as GitHubPushWebhookPayload | undefined;
			if (!payload || payload.deleted) {
				continue;
			}
			if (!isStartupDocsRepositoryPayload(payload)) {
				console.log(
					`Ignoring Startup docs push ${event.deliveryId}: repository does not match configured docs repo.`,
				);
				continue;
			}

			const ref = githubRefName(payload.ref) ?? startupDocsBranch();
			const changed = startupDocsChangedPaths(payload);
			for (const path of changed.upserts) {
				const file = await fetchStartupDocsGithubFile(path, ref);
				await upsertStartupDocsNotionPage(
					notionClient,
					auth,
					dataSourceId,
					schema,
					file,
					"github-push",
				);
			}

			for (const path of changed.removed) {
				await markStartupDocsNotionPageArchived(
					notionClient,
					auth,
					dataSourceId,
					schema,
					path,
				);
			}
		}
	},
});

worker.webhook("startupDocsNotionPageWebhook", {
	title: "Startup Docs Notion Page Webhook",
	description:
		"Receives Notion Wiki page update deliveries and opens GitHub pull requests for Markdown doc edits.",
	execute: async (events, { notion }) => {
		const notionClient = notion as unknown as NotionClientLike;
		const auth = startupDocsNotionAuth();
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			startupDocsNotionTargetId(),
		);
		await ensureStartupDocsNotionSchema(notionClient, auth, dataSourceId);

		for (const event of events) {
			const pageIds = notionWebhookPageIds(event.body as NotionPageWebhookPayload);
			if (pageIds.length === 0) {
				console.log(
					`Ignoring Notion webhook ${event.deliveryId}: no page ID found.`,
				);
				continue;
			}

			for (const pageId of pageIds) {
				await syncStartupDocsNotionPageToGithub(
					notionClient,
					auth,
					pageId,
					false,
					"notion-webhook",
				);
			}
		}
	},
});

worker.sync("slackMessagesBackfill", {
	database: slackMessages,
	mode: "replace",
	schedule: "manual",
	execute: async (state: SlackBackfillState | undefined) => {
		const channels = requireSlackChannels();
		const channelIndex = state?.channelIndex ?? 0;
		const channel = channels[channelIndex];
		if (!channel) {
			return {
				changes: [],
				hasMore: false,
			};
		}

		const page = await fetchSlackHistoryPage(channel.id, {
			cursor: state?.cursor,
		});
		const nextCursor = page.nextCursor;
		const nextChannelIndex = channelIndex + 1;

		return {
			changes: page.messages.map((message) =>
				slackMessageChange(message, channel),
			),
			hasMore: Boolean(nextCursor) || nextChannelIndex < channels.length,
			nextState: nextCursor
				? { channelIndex, cursor: nextCursor }
				: nextChannelIndex < channels.length
					? { channelIndex: nextChannelIndex }
					: undefined,
		};
	},
});

worker.sync("slackMessagesDelta", {
	database: slackMessages,
	mode: "incremental",
	schedule: "5m",
	execute: async (state: SlackDeltaState | undefined) => {
		const channels = requireSlackChannels();
		const channelIndex = state?.channelIndex ?? 0;
		const channel = channels[channelIndex];
		if (!channel) {
			return {
				changes: [],
				hasMore: false,
			};
		}

		const oldest = state?.oldest ?? slackTimestampFromDate(bufferedSlackDeltaDate());
		const page = await fetchSlackHistoryPage(channel.id, {
			cursor: state?.cursor,
			oldest,
			inclusive: false,
		});
		const cycleMaxTs = maxSlackTs(
			state?.cycleMaxTs,
			...page.messages.map((message) => message.ts),
			...page.messages.map((message) => message.edited?.ts),
		);
		const nextCursor = page.nextCursor;
		const nextChannelIndex = channelIndex + 1;

		return {
			changes: page.messages.map((message) =>
				slackMessageChange(message, channel),
			),
			hasMore: Boolean(nextCursor) || nextChannelIndex < channels.length,
			nextState: nextCursor
				? {
						channelIndex,
						cursor: nextCursor,
						oldest,
						cycleMaxTs,
					}
				: nextChannelIndex < channels.length
					? {
							channelIndex: nextChannelIndex,
							oldest,
							cycleMaxTs,
						}
					: {
							oldest: nextSlackDeltaCursor(oldest, cycleMaxTs),
						},
		};
	},
});

type StartupDocsNotionSchema = {
	titleProperty: string;
};

function startupDocsOwner(): string {
	return process.env.STARTUP_DOCS_GITHUB_OWNER ?? STARTUP_DOCS_OWNER_DEFAULT;
}

function startupDocsRepo(): string {
	return process.env.STARTUP_DOCS_GITHUB_REPO ?? STARTUP_DOCS_REPO_DEFAULT;
}

function startupDocsBranch(): string {
	return process.env.STARTUP_DOCS_GITHUB_BRANCH ?? STARTUP_DOCS_BRANCH_DEFAULT;
}

function startupDocsNotionTargetId(): string {
	return (
		process.env.STARTUP_DOCS_NOTION_DATA_SOURCE_ID ??
		process.env.STARTUP_DOCS_NOTION_DATABASE_ID ??
		STARTUP_DOCS_NOTION_DATA_SOURCE_ID_DEFAULT
	);
}

function startupDocsNotionAuth(): string {
	return requireAnyEnv("STARTUP_DOCS_NOTION_API_TOKEN", "NOTION_API_TOKEN");
}

function startupDocsGithubWebhookSecret(): string {
	return requireAnyEnv("STARTUP_DOCS_GITHUB_WEBHOOK_SECRET", "GITHUB_WEBHOOK_SECRET");
}

function isStartupDocsPath(path: string): boolean {
	if (!path.endsWith(".md")) {
		return false;
	}

	return (
		path === "README.md" ||
		path === "docs/README.md" ||
		path.startsWith("docs/product/") ||
		path.startsWith("docs/architecture/adr/") ||
		path.startsWith("docs/runbooks/")
	);
}

function startupDocsChangedPaths(payload: GitHubPushWebhookPayload): {
	upserts: string[];
	removed: string[];
} {
	const upserts = new Set<string>();
	const removed = new Set<string>();

	for (const commit of payload.commits ?? []) {
		for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
			if (isStartupDocsPath(path)) {
				upserts.add(path);
				removed.delete(path);
			}
		}
		for (const path of commit.removed ?? []) {
			if (isStartupDocsPath(path)) {
				removed.add(path);
				upserts.delete(path);
			}
		}
	}

	return {
		upserts: [...upserts].sort(),
		removed: [...removed].sort(),
	};
}

function isStartupDocsRepositoryPayload(payload: GitHubPushWebhookPayload): boolean {
	const expected = `${startupDocsOwner()}/${startupDocsRepo()}`.toLowerCase();
	const fullName = payload.repository?.full_name?.toLowerCase();
	return !fullName || fullName === expected;
}

function githubRefName(ref: string | undefined): string | undefined {
	return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

async function ensureStartupDocsNotionSchema(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
): Promise<StartupDocsNotionSchema> {
	const dataSource = await notion.dataSources.retrieve({
		auth,
		data_source_id: dataSourceId,
	});
	const properties = objectValue(objectValue(dataSource)?.properties) ?? {};
	const titleProperty =
		Object.entries(properties).find(
			([, property]) => objectValue(property)?.type === "title",
		)?.[0] ?? "Title";
	const missingProperties: Record<string, unknown> = {};

	for (const [name, config] of Object.entries({
		"GitHub Path": { rich_text: {} },
		"GitHub SHA": { rich_text: {} },
		"GitHub URL": { url: {} },
		"Last Synced At": { date: {} },
		"Sync Source": { rich_text: {} },
		"Sync Status": { rich_text: {} },
		"Notion Content Hash": { rich_text: {} },
	})) {
		if (!properties[name]) {
			missingProperties[name] = config;
		}
	}

	if (!properties[STARTUP_DOCS_RELATED_PROPERTY]) {
		missingProperties[STARTUP_DOCS_RELATED_PROPERTY] = {
			relation: {
				data_source_id: dataSourceId,
				type: "single_property",
				single_property: {},
			},
		};
	}

	if (Object.keys(missingProperties).length > 0) {
		await notion.dataSources.update({
			auth,
			data_source_id: dataSourceId,
			properties: missingProperties,
		});
	}

	return { titleProperty };
}

async function listStartupDocsMarkdownPaths(ref: string): Promise<string[]> {
	const tree = await githubRequest<{
		tree?: Array<{ path?: string; type?: string }>;
	}>(
		"GET",
		`/repos/${encodeURIComponent(startupDocsOwner())}/${encodeURIComponent(startupDocsRepo())}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
	);

	return (tree.tree ?? [])
		.filter((item) => item.type === "blob" && item.path && isStartupDocsPath(item.path))
		.map((item) => item.path as string)
		.sort();
}

async function fetchStartupDocsGithubFile(
	path: string,
	ref: string,
): Promise<StartupDocsGithubFile> {
	const file = await githubRequest<{
		sha?: string;
		content?: string;
		encoding?: string;
		html_url?: string;
		path?: string;
	}>(
		"GET",
		`/repos/${encodeURIComponent(startupDocsOwner())}/${encodeURIComponent(startupDocsRepo())}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(ref)}`,
	);
	if (file.encoding !== "base64" || !file.content || !file.sha) {
		throw new Error(`GitHub file ${path} did not return base64 content and sha.`);
	}

	return {
		path,
		sha: file.sha,
		htmlUrl:
			file.html_url ??
			`https://github.com/${startupDocsOwner()}/${startupDocsRepo()}/blob/${ref}/${path}`,
		content: Buffer.from(file.content, "base64").toString("utf8"),
		ref,
	};
}

async function upsertStartupDocsNotionPage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	schema: StartupDocsNotionSchema,
	file: StartupDocsGithubFile,
	source: string,
): Promise<void> {
	const markdown = startupDocsNotionMarkdown(file);
	const existing = await findStartupDocsNotionPage(
		notion,
		auth,
		dataSourceId,
		schema,
		file.path,
		startupDocsTitleFromMarkdown(file.content, file.path),
	);
	const properties = startupDocsNotionProperties(file, schema, source, markdown);

	if (existing) {
		await notion.pages.update({
			auth,
			page_id: existing.id,
			archived: false,
			properties,
		});
		await notion.pages.updateMarkdown({
			auth,
			page_id: existing.id,
			type: "replace_content",
			replace_content: {
				new_str: markdown,
				allow_deleting_content: true,
			},
		});
		return;
	}

	await notion.pages.create({
		auth,
		parent: {
			type: "data_source_id",
			data_source_id: dataSourceId,
		},
		properties,
		markdown,
	});
}

async function markStartupDocsNotionPageArchived(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	schema: StartupDocsNotionSchema,
	path: string,
): Promise<void> {
	const existing = await findStartupDocsNotionPage(
		notion,
		auth,
		dataSourceId,
		schema,
		path,
		undefined,
	);
	if (!existing) {
		return;
	}

	await notion.pages.update({
		auth,
		page_id: existing.id,
		properties: {
			Status: { status: { name: "Archived" } },
			"Sync Source": notionRichText("github-push"),
			"Sync Status": notionRichText("Deleted in GitHub"),
			"Last Synced At": notionDate(new Date().toISOString()),
		},
	});
}

async function findStartupDocsNotionPage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	schema: StartupDocsNotionSchema,
	path: string,
	title: string | undefined,
): Promise<{ id: string; object: string } | undefined> {
	const byPath = await notion.dataSources.query({
		auth,
		data_source_id: dataSourceId,
		page_size: 1,
		result_type: "page",
		filter: {
			property: "GitHub Path",
			rich_text: {
				equals: path,
			},
		},
	});
	const pathMatch = byPath.results.find((result) => result.object === "page");
	if (pathMatch || !title) {
		return pathMatch;
	}

	const byTitle = await notion.dataSources.query({
		auth,
		data_source_id: dataSourceId,
		page_size: 1,
		result_type: "page",
		filter: {
			property: schema.titleProperty,
			title: {
				equals: title,
			},
		},
	});

	return byTitle.results.find((result) => result.object === "page");
}

function startupDocsNotionProperties(
	file: StartupDocsGithubFile,
	schema: StartupDocsNotionSchema,
	source: string,
	markdown: string,
): Record<string, unknown> {
	const title = startupDocsTitleFromMarkdown(file.content, file.path);
	const category = startupDocsCategory(file.path);
	const now = new Date().toISOString();

	return {
		[schema.titleProperty]: notionTitle(title),
		Category: { select: { name: category } },
		Tags: {
			multi_select: startupDocsTags(file.path).map((name) => ({ name })),
		},
		Status: { status: { name: "Published" } },
		Priority: { select: { name: startupDocsPriority(file.path) } },
		"Last Updated": notionDate(startupDocsLastUpdated(file.content) ?? now.slice(0, 10)),
		"GitHub Path": notionRichText(file.path),
		"GitHub SHA": notionRichText(file.sha),
		"GitHub URL": notionUrl(file.htmlUrl),
		"Last Synced At": notionDate(now),
		"Sync Source": notionRichText(source),
		"Sync Status": notionRichText("Synced from GitHub"),
		"Notion Content Hash": notionRichText(hashContent(markdown)),
	};
}

function startupDocsNotionMarkdown(file: StartupDocsGithubFile): string {
	return [
		`> Source path: ${file.path}`,
		`> GitHub SHA: ${file.sha}`,
		"",
		file.content.trimEnd(),
		"",
	].join("\n");
}

function startupDocsTitleFromMarkdown(markdown: string, path: string): string {
	const heading = /^#\s+(.+)$/m.exec(markdown);
	if (heading) {
		return stripMarkdownInline(heading[1]).slice(0, 180);
	}

	const segments = path.split("/");
	return segments[segments.length - 1]
		.replace(/\.md$/, "")
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function startupDocsCategory(path: string): string {
	if (path.includes("/architecture/adr/")) {
		return "Engineering";
	}
	if (path.includes("/runbooks/")) {
		return "Operations";
	}
	return "Product";
}

function startupDocsTags(path: string): string[] {
	const tags = new Set(["Documentation"]);
	if (path.includes("/runbooks/")) {
		tags.add("Guide");
	} else if (path.includes("/decisions/") || path.includes("/adr/")) {
		tags.add("Best Practice");
	} else {
		tags.add("Reference");
	}
	if (path.includes("onboarding")) {
		tags.add("Onboarding");
	}
	return [...tags];
}

function startupDocsPriority(path: string): string {
	return /(^README\.md$|^docs\/README\.md$|prd\.md$|design-doc\.md$|roadmap\.md$|qa-checklists\.md$|release-readiness\.md$|runbooks\/README\.md$)/.test(
		path,
	)
		? "High"
		: "Medium";
}

function startupDocsLastUpdated(markdown: string): string | undefined {
	return /^>\s*\*\*Last Updated\*\*:\s*(\d{4}-\d{2}-\d{2})/im.exec(markdown)?.[1];
}

function stripMarkdownInline(value: string): string {
	return value
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_~]/g, "")
		.trim();
}

function notionWebhookPageIds(payload: NotionPageWebhookPayload): string[] {
	const ids = new Set<string>();
	if (payload.entity?.type === "page" && payload.entity.id) {
		ids.add(payload.entity.id);
	}
	if (payload.data?.id && payload.type?.includes("page")) {
		ids.add(payload.data.id);
	}
	for (const block of payload.data?.updated_blocks ?? []) {
		if (block.id && (!block.type || block.type === "page")) {
			ids.add(block.id);
		}
	}
	return [...ids];
}

async function syncStartupDocsNotionPageToGithub(
	notion: NotionClientLike,
	auth: string,
	pageId: string,
	dryRun: boolean,
	source: string,
): Promise<{ [key: string]: JSONValue }> {
	const page = objectValue(
		await notion.pages.retrieve({
			auth,
			page_id: pageId,
		}),
	);
	const properties = objectValue(page?.properties) ?? {};
	const path = richTextPropertyValue(properties["GitHub Path"]);
	if (!path || !isStartupDocsPath(path)) {
		return {
			skipped: true,
			reason: "Page is not mapped to a Startup Intros Markdown path.",
			pageId,
		};
	}

	const markdownResponse = objectValue(
		await notion.pages.retrieveMarkdown({
			auth,
			page_id: pageId,
		}),
	);
	const notionMarkdown = stringValue(markdownResponse?.markdown);
	const currentHash = hashContent(notionMarkdown);
	const storedHash = richTextPropertyValue(properties["Notion Content Hash"]);
	if (storedHash && storedHash === currentHash) {
		return {
			skipped: true,
			reason: "Notion content hash matches the last synced GitHub content.",
			pageId,
			path,
		};
	}

	const content = cleanupNotionMarkdownForGithub(notionMarkdown, path);
	if (dryRun) {
		return {
			dryRun,
			pageId,
			path,
			characters: content.length,
			source,
		};
	}

	const pr = await createStartupDocsGithubPullRequest(path, content, pageId);
	await notion.pages.update({
		auth,
		page_id: pageId,
		properties: {
			"Last Synced At": notionDate(new Date().toISOString()),
			"Sync Source": notionRichText(source),
			"Sync Status": notionRichText(`Opened PR ${pr.html_url ?? ""}`.trim()),
		},
	});

	return {
		dryRun,
		pageId,
		path,
		pullRequestUrl: pr.html_url ?? null,
	};
}

function cleanupNotionMarkdownForGithub(markdown: string, path: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	while (
		lines[0]?.includes(`Source path: ${path}`) ||
		lines[0]?.startsWith("> GitHub SHA:") ||
		lines[0]?.trim() === ""
	) {
		lines.shift();
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

async function createStartupDocsGithubPullRequest(
	path: string,
	content: string,
	pageId: string,
): Promise<{ html_url?: string; number?: number }> {
	const owner = startupDocsOwner();
	const repo = startupDocsRepo();
	const base = startupDocsBranch();
	const baseRef = await githubRequest<{
		object?: {
			sha?: string;
		};
	}>(
		"GET",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(base)}`,
	);
	const baseSha = baseRef.object?.sha;
	if (!baseSha) {
		throw new Error(`Could not resolve ${owner}/${repo} ${base} base SHA.`);
	}

	const branch = `docs/notion-sync-${pageId.replace(/-/g, "").slice(0, 8)}-${Date.now()}`;
	await githubRequest(
		"POST",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
		{
			ref: `refs/heads/${branch}`,
			sha: baseSha,
		},
	);
	const existing = await githubRequestOptional<{ sha?: string }>(
		"GET",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(branch)}`,
	);
	await githubRequest(
		"PUT",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponentPath(path)}`,
		{
			message: `Update ${path} from Notion Wiki`,
			content: Buffer.from(content, "utf8").toString("base64"),
			branch,
			...(existing?.sha ? { sha: existing.sha } : {}),
		},
	);

	return githubRequest<{ html_url?: string; number?: number }>(
		"POST",
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
		{
			title: `Update ${path} from Notion Wiki`,
			head: branch,
			base,
			body: [
				"Automated documentation sync from Notion Wiki.",
				"",
				`Notion page: ${pageId}`,
				"",
				"This PR was opened instead of pushing directly to main so Markdown changes can be reviewed before becoming the repo source of truth.",
			].join("\n"),
		},
	);
}

async function githubRequest<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			...githubHeaders(requireEnv("GITHUB_TOKEN")),
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	await assertOk(response, `GitHub ${method} ${path}`);
	return (await response.json()) as T;
}

async function githubRequestOptional<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T | undefined> {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			...githubHeaders(requireEnv("GITHUB_TOKEN")),
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (response.status === 404) {
		return undefined;
	}
	await assertOk(response, `GitHub ${method} ${path}`);
	return (await response.json()) as T;
}

function encodeURIComponentPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function richTextPropertyValue(property: unknown): string {
	const richText = arrayValue(objectValue(property)?.rich_text);
	return richText
		.map((item) => stringValue(objectValue(item)?.plain_text))
		.join("");
}

worker.sync("sentryIssuesSync", {
	database: sentryIssues,
	mode: "replace",
	schedule: "30m",
	execute: async (state: SentrySyncState | undefined, { notion }) => {
		const token = requireEnv("SENTRY_AUTH_TOKEN");
		const orgSlug = requireAnyEnv("SENTRY_ORG_SLUG", "SENTRY_ORG");
		const allowedProjects = parseCsv(
			process.env.SENTRY_PROJECT_SLUGS ?? process.env.SENTRY_PROJECT,
		);
		const auth = requireAnyEnv("SENTRY_NOTION_API_TOKEN", "NOTION_API_TOKEN");
		const notionClient = notion as unknown as NotionClientLike;
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			requireAnyEnv("SENTRY_NOTION_DATABASE_ID", "NOTION_SENTRY_DATABASE_ID"),
		);
		await ensureSentryNotionSchema(notionClient, auth, dataSourceId);
		const url = new URL(
			`https://sentry.io/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/`,
		);
		url.searchParams.set("query", "is:unresolved");
		url.searchParams.set("limit", "100");
		url.searchParams.set("sort", "date");
		if (state?.cursor) {
			url.searchParams.set("cursor", state.cursor);
		}

		await sentryApi.wait();
		const { body: issues, nextCursor } = await fetchJsonWithPagination<
			SentryIssue[]
		>(
			url,
			{
				headers: {
					Authorization: `Bearer ${token}`,
				},
			},
			"Sentry unresolved issues",
		);

		const filteredIssues =
			allowedProjects.length > 0
				? issues.filter((issue) =>
						allowedProjects.includes(issue.project?.slug ?? ""),
					)
				: issues;

		for (const issue of filteredIssues) {
			const debug = await fetchSentryIssueDebugContext(
				orgSlug,
				issue.id,
				token,
				undefined,
			);
			await upsertSentryIssuePage(notionClient, auth, dataSourceId, {
				...issue,
				debug,
			});
		}

		return {
			changes: [],
			hasMore: nextCursor !== undefined,
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},
});

async function fetchGithubIssuesPage(options: {
	page: number;
	updatedSince?: string;
	usePacer?: boolean;
}): Promise<{ issues: GitHubIssue[]; hasMore: boolean }> {
	const owner = process.env.GITHUB_OWNER ?? GITHUB_OWNER_DEFAULT;
	const repo = process.env.GITHUB_REPO ?? GITHUB_REPO_DEFAULT;
	const token = requireEnv("GITHUB_TOKEN");
	const url = new URL(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
	);
	url.searchParams.set("state", "all");
	url.searchParams.set("sort", "updated");
	url.searchParams.set("direction", "asc");
	url.searchParams.set("per_page", String(GITHUB_ISSUES_PAGE_SIZE));
	url.searchParams.set("page", String(options.page));
	if (options.updatedSince) {
		url.searchParams.set("since", options.updatedSince);
	}

	if (options.usePacer !== false) {
		await githubApi.wait();
	}
	const response = await fetch(url, {
		headers: githubHeaders(token),
	});
	await assertOk(response, "GitHub issues and pull requests");

	return {
		issues: (await response.json()) as GitHubIssue[],
		hasMore: hasNextRel(response.headers.get("link")),
	};
}

async function enrichGithubIssues(
	issues: GitHubIssue[],
	options: { usePacer?: boolean } = {},
): Promise<EnrichedGitHubIssue[]> {
	const enriched: EnrichedGitHubIssue[] = [];
	for (const issue of issues) {
		enriched.push(await enrichGithubIssue(issue, options));
	}

	return enriched;
}

async function enrichGithubIssue(
	issue: GitHubIssue,
	options: { usePacer?: boolean } = {},
): Promise<EnrichedGitHubIssue> {
	const context = await fetchGithubIssueContext(issue, options);
	return { issue, context };
}

async function fetchGithubIssueContext(
	issue: GitHubIssue,
	options: { usePacer?: boolean } = {},
): Promise<GitHubIssueContext> {
	const owner = process.env.GITHUB_OWNER ?? GITHUB_OWNER_DEFAULT;
	const repo = process.env.GITHUB_REPO ?? GITHUB_REPO_DEFAULT;
	const syncedAt = new Date().toISOString();
	const context: GitHubIssueContext = {
		comments: [],
		reviews: [],
		files: [],
		commits: [],
		syncedAt,
	};

	context.detail = await fetchGithubJson<GitHubIssue>(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue.number}`,
		`GitHub issue #${issue.number}`,
		options,
	);

	const commentsLimit = githubContextLimit(
		"GITHUB_CONTEXT_COMMENTS_LIMIT",
		GITHUB_CONTEXT_COMMENTS_LIMIT,
	);
	if (commentsLimit > 0) {
		context.comments = await fetchGithubJson<GitHubIssueComment[]>(
			githubLimitedUrl(
				`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue.number}/comments`,
				commentsLimit,
			),
			`GitHub comments for #${issue.number}`,
			options,
		);
	}

	if (!issue.pull_request) {
		return context;
	}

	context.pullRequest = await fetchGithubJson<GitHubPullRequest>(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${issue.number}`,
		`GitHub pull request #${issue.number}`,
		options,
	);

	const filesLimit = githubContextLimit(
		"GITHUB_CONTEXT_FILES_LIMIT",
		GITHUB_CONTEXT_FILES_LIMIT,
	);
	if (filesLimit > 0) {
		context.files = await fetchGithubJson<GitHubPullRequestFile[]>(
			githubLimitedUrl(
				`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${issue.number}/files`,
				filesLimit,
			),
			`GitHub pull request files for #${issue.number}`,
			options,
		);
	}

	const commitsLimit = githubContextLimit(
		"GITHUB_CONTEXT_COMMITS_LIMIT",
		GITHUB_CONTEXT_COMMITS_LIMIT,
	);
	if (commitsLimit > 0) {
		context.commits = await fetchGithubJson<GitHubPullRequestCommit[]>(
			githubLimitedUrl(
				`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${issue.number}/commits`,
				commitsLimit,
			),
			`GitHub pull request commits for #${issue.number}`,
			options,
		);
	}

	const reviewsLimit = githubContextLimit(
		"GITHUB_CONTEXT_REVIEWS_LIMIT",
		GITHUB_CONTEXT_REVIEWS_LIMIT,
	);
	if (reviewsLimit > 0) {
		context.reviews = await fetchGithubJson<GitHubPullRequestReview[]>(
			githubLimitedUrl(
				`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${issue.number}/reviews`,
				reviewsLimit,
			),
			`GitHub pull request reviews for #${issue.number}`,
			options,
		);
	}

	return context;
}

async function fetchGithubJson<T>(
	url: string,
	description: string,
	options: { usePacer?: boolean } = {},
): Promise<T> {
	if (options.usePacer !== false) {
		await githubApi.wait();
	}
	const response = await fetch(url, {
		headers: githubHeaders(requireEnv("GITHUB_TOKEN")),
	});
	await assertOk(response, description);
	return (await response.json()) as T;
}

function githubLimitedUrl(url: string, limit: number): string {
	const limitedUrl = new URL(url);
	limitedUrl.searchParams.set("per_page", String(limit));
	return limitedUrl.toString();
}

function githubContextLimit(envName: string, fallback: number): number {
	return readIntegerEnv(envName, fallback, 0, 100);
}

function githubHeaders(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

function githubIssueChange(issue: GitHubIssue) {
	const owner = process.env.GITHUB_OWNER ?? GITHUB_OWNER_DEFAULT;
	const repo = process.env.GITHUB_REPO ?? GITHUB_REPO_DEFAULT;
	const repoFullName = `${owner}/${repo}`;
	const type = issue.pull_request ? "Pull Request" : "Issue";
	const url = issue.pull_request?.html_url ?? issue.html_url;

	return {
		type: "upsert" as const,
		key: String(issue.id),
		properties: {
			Title: Builder.title(issue.title ?? `${type} #${issue.number}`),
			"GitHub Item ID": Builder.richText(String(issue.id)),
			Number: Builder.number(issue.number),
			Type: Builder.richText(type),
			State: Builder.richText(issue.state ?? ""),
			"State Reason": Builder.richText(issue.state_reason ?? ""),
			Author: Builder.richText(issue.user?.login ?? ""),
			Assignees: Builder.richText(
				(issue.assignees ?? [])
					.map((assignee) => assignee.login)
					.filter(Boolean)
					.join(", "),
			),
			Labels: Builder.richText(formatGithubLabels(issue.labels)),
			Milestone: Builder.richText(issue.milestone?.title ?? ""),
			Comments: Builder.number(issue.comments ?? 0),
			Locked: Builder.checkbox(Boolean(issue.locked)),
			"Created Time": dateTimeOrEmpty(issue.created_at),
			"Updated Time": dateTimeOrEmpty(issue.updated_at),
			"Closed Time": dateTimeOrEmpty(issue.closed_at),
			URL: urlOrEmpty(url),
			"Repo Full Name": Builder.richText(repoFullName),
		},
		upstreamUpdatedAt: issue.updated_at,
		pageContentMarkdown: githubIssueMarkdown({ issue }, repoFullName, type, url),
	};
}

function formatGithubLabels(labels: GitHubIssue["labels"]): string {
	return (labels ?? [])
		.map((label) => (typeof label === "string" ? label : label.name))
		.filter(Boolean)
		.join(", ");
}

function githubIssueMarkdown(
	enrichedIssue: EnrichedGitHubIssue,
	repoFullName: string,
	type: string,
	url: string | undefined,
): string {
	const { issue, context } = enrichedIssue;
	const detail = context?.pullRequest ?? context?.detail ?? issue;
	const pullRequest = context?.pullRequest;
	const body = detail.body?.trim();
	const lines = [
		`# ${issue.title ?? `${type} #${issue.number}`}`,
		"",
		"## Summary",
		"",
		body ? toBoundedMarkdown(body, 8000) : "No description provided.",
		"",
		"## Metadata",
		"",
		`- Type: ${type}`,
		`- Repo: ${repoFullName}`,
		`- Number: #${issue.number}`,
		`- State: ${issue.state ?? "Unknown"}`,
		`- State reason: ${issue.state_reason ?? "Unknown"}`,
		`- Author: ${issue.user?.login ?? "Unknown"}`,
		`- Assignees: ${
			(issue.assignees ?? [])
				.map((assignee) => assignee.login)
				.filter(Boolean)
				.join(", ") || "None"
		}`,
		`- Labels: ${formatGithubLabels(issue.labels) || "None"}`,
		`- Created: ${issue.created_at ?? "Unknown"}`,
		`- Updated: ${issue.updated_at ?? "Unknown"}`,
		`- Closed: ${issue.closed_at ?? "Open"}`,
		`- Comments: ${issue.comments ?? 0}`,
		`- Locked: ${issue.locked ? "Yes" : "No"}`,
		...(context?.syncedAt ? [`- Context synced: ${context.syncedAt}`] : []),
		`- Source: ${url ?? "Unavailable"}`,
	];

	if (pullRequest) {
		lines.push(
			"",
			"## PR Details",
			"",
			`- Merged: ${pullRequest.merged ? "Yes" : "No"}`,
			`- Draft: ${pullRequest.draft ? "Yes" : "No"}`,
			`- Mergeable state: ${pullRequest.mergeable_state ?? "Unknown"}`,
			`- Changed files: ${pullRequest.changed_files ?? 0}`,
			`- Additions: ${pullRequest.additions ?? 0}`,
			`- Deletions: ${pullRequest.deletions ?? 0}`,
		);
	}

	if (context?.comments.length) {
		lines.push("", "## Recent Discussion", "");
		for (const comment of context.comments) {
			lines.push(formatGithubCommentMarkdown(comment));
		}
	}

	if (context?.files.length) {
		lines.push("", "## Changed Files", "");
		for (const file of context.files) {
			lines.push(
				`- ${file.filename ?? "Unknown file"} (${file.status ?? "unknown"}, +${file.additions ?? 0}/-${file.deletions ?? 0}, ${file.changes ?? 0} changes)`,
			);
		}
	}

	if (context?.commits.length) {
		lines.push("", "## Commits", "");
		for (const commit of context.commits) {
			lines.push(formatGithubCommitMarkdown(commit));
		}
	}

	if (context?.reviews.length) {
		lines.push("", "## Reviews", "");
		for (const review of context.reviews) {
			lines.push(formatGithubReviewMarkdown(review));
		}
	}

	lines.push(
		"",
		"## Links",
		"",
		`- GitHub: ${url ?? "Unavailable"}`,
	);

	return toBoundedMarkdown(lines.join("\n"), 60000);
}

function formatGithubCommentMarkdown(comment: GitHubIssueComment): string {
	const author = comment.user?.login ?? "Unknown";
	const updated = comment.updated_at ?? comment.created_at ?? "Unknown time";
	const body = comment.body?.trim()
		? markdownCodeBlock(toBoundedMarkdown(comment.body.trim(), 2000), "md")
		: "No comment body.";

	return [
		`### ${author} at ${updated}`,
		"",
		body,
		comment.html_url ? `\n${comment.html_url}` : "",
		"",
	].join("\n");
}

function formatGithubCommitMarkdown(commit: GitHubPullRequestCommit): string {
	const sha = commit.sha ? commit.sha.slice(0, 7) : "unknown";
	const message = firstLine(commit.commit?.message ?? "No commit message");
	const author =
		commit.author?.login ?? commit.commit?.author?.name ?? "Unknown author";
	const date = commit.commit?.author?.date ?? "Unknown date";
	const link = commit.html_url ? ` ${commit.html_url}` : "";
	return `- \`${sha}\` ${message} by ${author} at ${date}${link}`;
}

function formatGithubReviewMarkdown(review: GitHubPullRequestReview): string {
	const author = review.user?.login ?? "Unknown";
	const state = review.state ?? "UNKNOWN";
	const submittedAt = review.submitted_at ?? "Unknown time";
	const body = review.body?.trim()
		? `\n\n${markdownCodeBlock(toBoundedMarkdown(review.body.trim(), 1200), "md")}`
		: "";
	const link = review.html_url ? `\n\n${review.html_url}` : "";
	return [`### ${state} by ${author} at ${submittedAt}`, body, link, ""].join(
		"\n",
	);
}

function githubReviewState(reviews: GitHubPullRequestReview[]): string {
	const states = reviews
		.map((review) => review.state)
		.filter((state): state is string => Boolean(state));
	if (states.length === 0) {
		return "";
	}

	return states.slice(-5).join(", ");
}

function firstLine(value: string): string {
	return value.split(/\r?\n/)[0]?.trim() ?? "";
}

function toBoundedMarkdown(content: string, maxLength = 12000): string {
	if (content.length <= maxLength) {
		return content;
	}

	return `${content.slice(0, maxLength - 26)}\n\n... truncated for Notion`;
}

function markdownCodeBlock(content: string, language = ""): string {
	const safeContent = content.replace(/```/g, "'''");
	return [`\`\`\`${language}`, safeContent, "```"].join("\n");
}

type GithubNotionSchema = {
	titleProperty: string;
};

function githubNotionAuth(): string {
	return requireAnyEnv("GITHUB_NOTION_API_TOKEN", "NOTION_API_TOKEN");
}

function githubNotionTargetId(): string {
	return (
		process.env.GITHUB_NOTION_DATA_SOURCE_ID ??
		process.env.GITHUB_NOTION_DATABASE_ID ??
		GITHUB_NOTION_DATA_SOURCE_ID_DEFAULT
	);
}

async function ensureGithubNotionSchema(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
): Promise<GithubNotionSchema> {
	const dataSource = await notion.dataSources.retrieve({
		auth,
		data_source_id: dataSourceId,
	});
	const properties = objectValue(objectValue(dataSource)?.properties) ?? {};
	const titleProperty =
		Object.entries(properties).find(
			([, property]) => objectValue(property)?.type === "title",
		)?.[0] ?? "Title";
	const missingProperties: Record<string, unknown> = {};

	for (const [name, config] of Object.entries({
		Source: { rich_text: {} },
		"GitHub Item ID": { rich_text: {} },
		Number: { number: { format: "number" } },
		Type: { rich_text: {} },
		State: { rich_text: {} },
		"State Reason": { rich_text: {} },
		Author: { rich_text: {} },
		Assignees: { rich_text: {} },
		Labels: { rich_text: {} },
		Milestone: { rich_text: {} },
		Comments: { number: { format: "number" } },
		Locked: { checkbox: {} },
		"Created Time": { date: {} },
		"Updated Time": { date: {} },
		"Closed Time": { date: {} },
		URL: { url: {} },
		"Repo Full Name": { rich_text: {} },
		"Context Synced Time": { date: {} },
		Merged: { checkbox: {} },
		Draft: { checkbox: {} },
		"Changed Files": { number: { format: "number" } },
		Additions: { number: { format: "number" } },
		Deletions: { number: { format: "number" } },
		"Review State": { rich_text: {} },
	})) {
		if (!properties[name]) {
			missingProperties[name] = config;
		}
	}

	if (Object.keys(missingProperties).length > 0) {
		await notion.dataSources.update({
			auth,
			data_source_id: dataSourceId,
			properties: missingProperties,
		});
	}

	return { titleProperty };
}

async function upsertGithubIssuePage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	enrichedIssue: EnrichedGitHubIssue,
	schema: GithubNotionSchema,
): Promise<void> {
	const { issue } = enrichedIssue;
	const { properties, markdown } = toNotionGithubIssuePage(enrichedIssue, schema);
	const page = await findGithubIssuePage(notion, auth, dataSourceId, issue);

	if (page) {
		await notion.pages.update({
			auth,
			page_id: page.id,
			archived: false,
			properties,
		});
		await notion.pages.updateMarkdown({
			auth,
			page_id: page.id,
			type: "replace_content",
			replace_content: {
				new_str: markdown,
				allow_deleting_content: true,
			},
		});
		return;
	}

	await notion.pages.create({
		auth,
		parent: {
			type: "data_source_id",
			data_source_id: dataSourceId,
		},
		properties,
		markdown,
	});
}

async function archiveGithubIssuePage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	issue: GitHubIssue,
): Promise<void> {
	const page = await findGithubIssuePage(notion, auth, dataSourceId, issue);
	if (!page) {
		return;
	}

	await notion.pages.update({
		auth,
		page_id: page.id,
		archived: true,
	});
}

async function findGithubIssuePage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	issue: GitHubIssue,
): Promise<{ id: string; object: string } | undefined> {
	const existing = await notion.dataSources.query({
		auth,
		data_source_id: dataSourceId,
		page_size: 1,
		result_type: "page",
		filter: {
			property: "GitHub Item ID",
			rich_text: {
				equals: String(issue.id),
			},
		},
	});

	return existing.results.find((result) => result.object === "page");
}

function toNotionGithubIssuePage(
	enrichedIssue: EnrichedGitHubIssue,
	schema: GithubNotionSchema,
): { properties: Record<string, unknown>; markdown: string } {
	const { issue, context } = enrichedIssue;
	const owner = process.env.GITHUB_OWNER ?? GITHUB_OWNER_DEFAULT;
	const repo = process.env.GITHUB_REPO ?? GITHUB_REPO_DEFAULT;
	const repoFullName = `${owner}/${repo}`;
	const type = issue.pull_request ? "Pull Request" : "Issue";
	const url = issue.pull_request?.html_url ?? issue.html_url;
	const pullRequest = context?.pullRequest;

	return {
		properties: {
			[schema.titleProperty]: notionTitle(issue.title ?? `${type} #${issue.number}`),
			Source: notionRichText("GitHub"),
			"GitHub Item ID": notionRichText(String(issue.id)),
			Number: notionNumber(issue.number),
			Type: notionRichText(type),
			State: notionRichText(issue.state ?? ""),
			"State Reason": notionRichText(issue.state_reason ?? ""),
			Author: notionRichText(issue.user?.login ?? ""),
			Assignees: notionRichText(
				(issue.assignees ?? [])
					.map((assignee) => assignee.login)
					.filter(Boolean)
					.join(", "),
			),
			Labels: notionRichText(formatGithubLabels(issue.labels)),
			Milestone: notionRichText(issue.milestone?.title ?? ""),
			Comments: notionNumber(issue.comments ?? 0),
			Locked: notionCheckbox(Boolean(issue.locked)),
			"Created Time": notionDate(issue.created_at),
			"Updated Time": notionDate(issue.updated_at),
			"Closed Time": notionDate(issue.closed_at ?? undefined),
			URL: notionUrl(url),
			"Repo Full Name": notionRichText(repoFullName),
			"Context Synced Time": notionDate(context?.syncedAt),
			Merged: notionCheckbox(Boolean(pullRequest?.merged)),
			Draft: notionCheckbox(Boolean(pullRequest?.draft)),
			"Changed Files": notionNumber(pullRequest?.changed_files ?? 0),
			Additions: notionNumber(pullRequest?.additions ?? 0),
			Deletions: notionNumber(pullRequest?.deletions ?? 0),
			"Review State": notionRichText(githubReviewState(context?.reviews ?? [])),
		},
		markdown: githubIssueMarkdown(enrichedIssue, repoFullName, type, url),
	};
}

function githubIssueNotionPreview(
	enrichedIssue: EnrichedGitHubIssue,
): Record<string, string | number | boolean | null> {
	const { issue, context } = enrichedIssue;
	const owner = process.env.GITHUB_OWNER ?? GITHUB_OWNER_DEFAULT;
	const repo = process.env.GITHUB_REPO ?? GITHUB_REPO_DEFAULT;
	const type = issue.pull_request ? "Pull Request" : "Issue";
	const pullRequest = context?.pullRequest;

	return {
		source: "GitHub",
		githubItemId: String(issue.id),
		title: issue.title ?? `${type} #${issue.number}`,
		number: issue.number,
		type,
		state: issue.state ?? "",
		author: issue.user?.login ?? "",
		updatedAt: issue.updated_at ?? "",
		url: issue.pull_request?.html_url ?? issue.html_url ?? "",
		repoFullName: `${owner}/${repo}`,
		contextSyncedAt: context?.syncedAt ?? null,
		contextComments: context?.comments.length ?? 0,
		contextFiles: context?.files.length ?? 0,
		contextCommits: context?.commits.length ?? 0,
		contextReviews: context?.reviews.length ?? 0,
		merged: pullRequest?.merged ?? null,
		draft: pullRequest?.draft ?? null,
		changedFiles: pullRequest?.changed_files ?? 0,
		additions: pullRequest?.additions ?? 0,
		deletions: pullRequest?.deletions ?? 0,
		reviewState: githubReviewState(context?.reviews ?? []),
	};
}

function normalizeGithubWebhookIssue(
	payload: GitHubWebhookPayload | undefined,
): GitHubIssue | undefined {
	if (!payload) {
		return undefined;
	}

	return payload.issue ?? payload.pull_request;
}

function verifyGithubWebhookSignature(
	rawBody: string,
	headers: Record<string, string>,
	secret: string,
): void {
	const signature = getHeader(headers, "x-hub-signature-256");
	if (!signature) {
		throw new WebhookVerificationError("Missing X-Hub-Signature-256");
	}

	const expected = `sha256=${crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex")}`;

	if (!timingSafeEqual(signature, expected)) {
		throw new WebhookVerificationError("Invalid X-Hub-Signature-256");
	}
}

type SlackChannelConfig = {
	id: string;
	name?: string;
};

async function fetchSlackHistoryPage(
	channelId: string,
	options: {
		cursor?: string;
		oldest?: string;
		inclusive?: boolean;
	},
): Promise<{ messages: SlackMessage[]; nextCursor?: string }> {
	const url = new URL("https://slack.com/api/conversations.history");
	url.searchParams.set("channel", channelId);
	url.searchParams.set("limit", String(slackHistoryLimit()));
	if (options.cursor) {
		url.searchParams.set("cursor", options.cursor);
	}
	if (options.oldest) {
		url.searchParams.set("oldest", options.oldest);
		url.searchParams.set("inclusive", options.inclusive ? "true" : "false");
	}

	await slackApi.wait();
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${requireEnv("SLACK_BOT_TOKEN")}`,
		},
	});
	await assertOk(response, `Slack conversations.history for ${channelId}`);

	const body = (await response.json()) as SlackHistoryResponse;
	if (!body.ok) {
		throw new Error(
			`Slack conversations.history for ${channelId} failed: ${
				body.error ?? "unknown_error"
			}`,
		);
	}

	const nextCursor = body.response_metadata?.next_cursor?.trim();
	return {
		messages: body.messages ?? [],
		nextCursor: nextCursor || undefined,
	};
}

function slackMessageChange(
	message: SlackMessage,
	channel: SlackChannelConfig,
) {
	const channelName = channel.name ?? "";
	const title = slackMessageTitle(message, channel);
	const messageTime = slackDateFromTimestamp(message.ts);
	const editedTime = message.edited?.ts
		? slackDateFromTimestamp(message.edited.ts)
		: undefined;

	return {
		type: "upsert" as const,
		key: slackMessageKey(message, channel.id),
		properties: {
			Message: Builder.title(title),
			"Slack Message ID": Builder.richText(slackMessageKey(message, channel.id)),
			"Channel ID": Builder.richText(channel.id),
			"Channel Name": Builder.richText(channelName),
			User: Builder.richText(message.user ?? message.username ?? ""),
			"Bot ID": Builder.richText(message.bot_id ?? ""),
			Type: Builder.richText(message.type ?? ""),
			Subtype: Builder.richText(message.subtype ?? ""),
			Text: Builder.richText(message.text ?? ""),
			"Message Time": dateTimeOrEmpty(messageTime),
			"Thread TS": Builder.richText(message.thread_ts ?? ""),
			"Reply Count": Builder.number(message.reply_count ?? 0),
			"Edited Time": dateTimeOrEmpty(editedTime),
			"Raw JSON": Builder.richText(toBoundedJson(message)),
		},
		upstreamUpdatedAt: editedTime ?? messageTime,
		pageContentMarkdown: slackMessageMarkdown(message, channel),
	};
}

function slackMessageTitle(
	message: SlackMessage,
	channel: SlackChannelConfig,
): string {
	const text = (message.text ?? "").replace(/\s+/g, " ").trim();
	if (text) {
		return truncateNotionText(text, 120);
	}

	const channelLabel = channel.name ? `#${channel.name}` : channel.id;
	return `Slack message in ${channelLabel} at ${slackDateFromTimestamp(message.ts)}`;
}

function slackMessageMarkdown(
	message: SlackMessage,
	channel: SlackChannelConfig,
): string {
	const channelLabel = channel.name ? `#${channel.name}` : channel.id;
	const lines = [
		`# ${slackMessageTitle(message, channel)}`,
		"",
		`- Channel: ${channelLabel}`,
		`- Channel ID: ${channel.id}`,
		`- User: ${message.user ?? message.username ?? "Unknown"}`,
		`- Message time: ${slackDateFromTimestamp(message.ts)}`,
		`- Thread TS: ${message.thread_ts ?? "None"}`,
		`- Reply count: ${message.reply_count ?? 0}`,
		`- Type: ${message.type ?? "Unknown"}`,
		`- Subtype: ${message.subtype ?? "None"}`,
	];

	if (message.edited?.ts) {
		lines.push(`- Edited: ${slackDateFromTimestamp(message.edited.ts)}`);
	}

	lines.push("", "## Text", "", message.text ?? "", "", "## Raw JSON", "");
	lines.push("```json", toBoundedJson(message, 6000), "```");
	return lines.join("\n");
}

function slackMessageKey(message: SlackMessage, channelId: string): string {
	return `${channelId}:${message.ts}`;
}

function requireSlackChannels(): SlackChannelConfig[] {
	const channelIds = parseCsv(process.env.SLACK_CHANNEL_IDS);
	if (channelIds.length === 0) {
		throw new Error(
			"SLACK_CHANNEL_IDS is required. Set it to comma-separated Slack conversation IDs the app can read, for example C123,D123,G123.",
		);
	}

	const namesById = parseSlackChannelNames(process.env.SLACK_CHANNEL_NAMES);
	return channelIds.map((id) => ({
		id,
		name: namesById.get(id),
	}));
}

function parseSlackChannelNames(value: string | undefined): Map<string, string> {
	const names = new Map<string, string>();
	for (const entry of parseCsv(value)) {
		const [id, ...nameParts] = entry.split("=");
		const name = nameParts.join("=").trim();
		if (id && name) {
			names.set(id.trim(), name);
		}
	}
	return names;
}

function slackHistoryLimit(): number {
	return readIntegerEnv("SLACK_HISTORY_PAGE_SIZE", SLACK_HISTORY_PAGE_SIZE, 1, 200);
}

function slackDateFromTimestamp(ts: string): string {
	const millis = Number(ts) * 1000;
	if (!Number.isFinite(millis)) {
		return new Date(0).toISOString();
	}

	return new Date(millis).toISOString();
}

function slackTimestampFromDate(date: Date): string {
	const seconds = date.getTime() / 1000;
	return seconds.toFixed(6);
}

function bufferedSlackDeltaDate(): Date {
	return new Date(Date.now() - SLACK_DELTA_BUFFER_MS);
}

function nextSlackDeltaCursor(
	previousOldest: string,
	cycleMaxTs: string | undefined,
): string {
	const bufferedCursor = slackTimestampFromDate(bufferedSlackDeltaDate());
	const nextObservedCursor = cycleMaxTs
		? minSlackTs(cycleMaxTs, bufferedCursor)
		: bufferedCursor;

	return maxSlackTs(previousOldest, nextObservedCursor) ?? bufferedCursor;
}

function maxSlackTs(
	...values: Array<string | undefined | null>
): string | undefined {
	const validValues = values.filter(
		(value): value is string =>
			typeof value === "string" && Number.isFinite(Number(value)),
	);
	if (validValues.length === 0) {
		return undefined;
	}

	return validValues.reduce((max, value) =>
		Number(value) > Number(max) ? value : max,
	);
}

function minSlackTs(first: string, second: string): string {
	return Number(first) <= Number(second) ? first : second;
}

worker.webhook("sentryIssueAlertWebhook", {
	title: "Sentry Issue Alert Webhook",
	description:
		"Receives verified Sentry issue-alert webhooks and upserts issues into a Notion database.",
	execute: async (events, { notion }) => {
		const auth = requireAnyEnv("SENTRY_NOTION_API_TOKEN", "NOTION_API_TOKEN");
		const databaseOrDataSourceId = requireAnyEnv(
			"SENTRY_NOTION_DATABASE_ID",
			"NOTION_SENTRY_DATABASE_ID",
		);
		const clientSecret = requireEnv("SENTRY_WEBHOOK_CLIENT_SECRET");
		const notionClient = notion as unknown as NotionClientLike;
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			auth,
			databaseOrDataSourceId,
		);
		await ensureSentryNotionSchema(notionClient, auth, dataSourceId);
		const token = requireEnv("SENTRY_AUTH_TOKEN");
		const orgSlug = requireAnyEnv("SENTRY_ORG_SLUG", "SENTRY_ORG");

		for (const event of events) {
			verifySentryWebhookSignature(
				event.rawBody,
				event.headers,
				clientSecret,
			);

			const issue = normalizeSentryWebhookIssue(event.body);
			if (!issue) {
				console.log(
					`Ignoring Sentry webhook ${event.deliveryId}: no data.issue payload found.`,
				);
				continue;
			}

			const debug = await fetchSentryIssueDebugContext(
				orgSlug,
				issue.id,
				token,
				objectValue(objectValue(event.body.data)?.event),
			);
			await upsertSentryIssuePage(notionClient, auth, dataSourceId, {
				...issue,
				debug,
			});
		}
	},
});

type NotionClientLike = {
	databases: {
		retrieve: (args: Record<string, unknown>) => Promise<unknown>;
	};
	dataSources: {
		retrieve: (args: Record<string, unknown>) => Promise<unknown>;
		query: (args: Record<string, unknown>) => Promise<{
			results: Array<{ id: string; object: string }>;
		}>;
		update: (args: Record<string, unknown>) => Promise<unknown>;
	};
	pages: {
		create: (args: Record<string, unknown>) => Promise<unknown>;
		retrieve: (args: Record<string, unknown>) => Promise<unknown>;
		retrieveMarkdown: (args: Record<string, unknown>) => Promise<unknown>;
		update: (args: Record<string, unknown>) => Promise<unknown>;
		updateMarkdown: (args: Record<string, unknown>) => Promise<unknown>;
	};
};

async function resolveDataSourceId(
	notion: NotionClientLike,
	auth: string,
	databaseOrDataSourceId: string,
): Promise<string> {
	const normalizedId = normalizeNotionId(databaseOrDataSourceId);

	try {
		const database = await notion.databases.retrieve({
			auth,
			database_id: normalizedId,
		});
		const dataSources = objectValue(database)?.data_sources;
		const firstDataSource = objectValue(arrayValue(dataSources)[0]);
		const dataSourceId = stringValue(firstDataSource?.id);
		if (dataSourceId) {
			return dataSourceId;
		}
	} catch (error) {
		console.log(
			`Could not retrieve ${normalizedId} as a database; treating it as a data source ID.`,
			error instanceof Error ? error.message : error,
		);
	}

	return normalizedId;
}

async function ensureSentryNotionSchema(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
): Promise<void> {
	const dataSource = await notion.dataSources.retrieve({
		auth,
		data_source_id: dataSourceId,
	});
	const properties = objectValue(objectValue(dataSource)?.properties) ?? {};
	const missingProperties: Record<string, unknown> = {};

	for (const [name, config] of Object.entries({
		Environment: { rich_text: {} },
		Release: { rich_text: {} },
		Transaction: { rich_text: {} },
		Platform: { rich_text: {} },
		Browser: { rich_text: {} },
		OS: { rich_text: {} },
		Runtime: { rich_text: {} },
		"Latest Event ID": { rich_text: {} },
		"Latest Event Time": { date: {} },
		Location: { rich_text: {} },
		"Top Stack Frame": { rich_text: {} },
		Tags: { rich_text: {} },
		User: { rich_text: {} },
		"Context Summary": { rich_text: {} },
	})) {
		if (!properties[name]) {
			missingProperties[name] = config;
		}
	}

	if (Object.keys(missingProperties).length > 0) {
		await notion.dataSources.update({
			auth,
			data_source_id: dataSourceId,
			properties: missingProperties,
		});
	}
}

async function fetchSentryIssueDebugContext(
	orgSlug: string,
	issueId: string,
	token: string,
	webhookEvent: JsonRecord | undefined,
): Promise<SentryDebugContext | undefined> {
	if (webhookEvent) {
		return sentryDebugContextFromEvent(webhookEvent);
	}

	const url = new URL(
		`https://sentry.io/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/events/`,
	);
	url.searchParams.set("full", "true");

	try {
		await sentryApi.wait();
		const events = await fetchJson<SentryEvent[]>(
			url,
			{
				headers: {
					Authorization: `Bearer ${token}`,
				},
			},
			`Sentry issue ${issueId} events`,
		);
		return sentryDebugContextFromEvent(objectValue(events[0]));
	} catch (error) {
		console.log(
			`Could not enrich Sentry issue ${issueId}; writing base issue fields only.`,
			error instanceof Error ? error.message : error,
		);
		return undefined;
	}
}

async function upsertSentryIssuePage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	issue: EnrichedSentryIssue,
): Promise<void> {
	const properties = toNotionSentryProperties(issue);
	const existing = await notion.dataSources.query({
		auth,
		data_source_id: dataSourceId,
		page_size: 1,
		result_type: "page",
		filter: {
			property: "Sentry Issue ID",
			rich_text: {
				equals: issue.id,
			},
		},
	});
	const page = existing.results.find((result) => result.object === "page");

	if (page) {
		await notion.pages.update({
			auth,
			page_id: page.id,
			properties,
		});
		await notion.pages.updateMarkdown({
			auth,
			page_id: page.id,
			type: "replace_content",
			replace_content: {
				new_str: sentryIssueMarkdown(issue),
				allow_deleting_content: true,
			},
		});
		return;
	}

	await notion.pages.create({
		auth,
		parent: {
			type: "data_source_id",
			data_source_id: dataSourceId,
		},
		properties,
		markdown: sentryIssueMarkdown(issue),
	});
}

function toNotionSentryProperties(issue: EnrichedSentryIssue) {
	const debug = issue.debug;
	return {
		Issue: notionTitle(issue.title ?? `Sentry issue ${issue.id}`),
		"Sentry Issue ID": notionRichText(issue.id),
		Culprit: notionRichText(issue.culprit ?? ""),
		Level: notionRichText(issue.level ?? ""),
		Status: notionRichText(issue.status ?? ""),
		Project: notionRichText(issue.project?.slug ?? issue.project?.name ?? ""),
		"User Count": notionNumber(toNumber(issue.userCount)),
		"Event Count": notionNumber(toNumber(issue.count)),
		"First Seen": notionDate(issue.firstSeen),
		"Last Seen": notionDate(issue.lastSeen),
		Permalink: notionUrl(issue.permalink),
		Environment: notionRichText(debug?.environment ?? ""),
		Release: notionRichText(debug?.release ?? ""),
		Transaction: notionRichText(debug?.transaction ?? ""),
		Platform: notionRichText(debug?.platform ?? ""),
		Browser: notionRichText(debug?.browser ?? ""),
		OS: notionRichText(debug?.os ?? ""),
		Runtime: notionRichText(debug?.runtime ?? ""),
		"Latest Event ID": notionRichText(debug?.latestEventId ?? ""),
		"Latest Event Time": notionDate(debug?.latestEventTime),
		Location: notionRichText(debug?.location ?? ""),
		"Top Stack Frame": notionRichText(debug?.topStackFrame ?? ""),
		Tags: notionRichText(debug?.tags ?? ""),
		User: notionRichText(debug?.user ?? ""),
		"Context Summary": notionRichText(debug?.contextSummary ?? ""),
	};
}

function notionTitle(content: string) {
	return {
		title: [
			{
				type: "text",
				text: {
					content: truncateNotionText(content),
				},
			},
		],
	};
}

function notionRichText(content: string) {
	return {
		rich_text: content
			? [
					{
						type: "text",
						text: {
							content: truncateNotionText(content),
						},
					},
				]
			: [],
	};
}

function notionNumber(value: number) {
	return {
		number: Number.isFinite(value) ? value : 0,
	};
}

function notionCheckbox(value: boolean) {
	return {
		checkbox: value,
	};
}

function notionDate(value: string | undefined) {
	return {
		date: value ? { start: value } : null,
	};
}

function notionUrl(value: string | undefined) {
	return {
		url: value || null,
	};
}

function truncateNotionText(content: string, maxLength = 1800): string {
	if (content.length <= maxLength) {
		return content;
	}

	return `${content.slice(0, maxLength - 14)}... truncated`;
}

function verifySentryWebhookSignature(
	rawBody: string,
	headers: Record<string, string>,
	clientSecret: string,
): void {
	const signature = getHeader(headers, "sentry-hook-signature");
	if (!signature) {
		throw new WebhookVerificationError("Missing Sentry-Hook-Signature");
	}

	const expected = crypto
		.createHmac("sha256", clientSecret)
		.update(rawBody)
		.digest("hex");

	if (!timingSafeEqual(signature, expected)) {
		throw new WebhookVerificationError("Invalid Sentry-Hook-Signature");
	}
}

function timingSafeEqual(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);

	return (
		actualBuffer.length === expectedBuffer.length &&
		crypto.timingSafeEqual(actualBuffer, expectedBuffer)
	);
}

function getHeader(
	headers: Record<string, string>,
	headerName: string,
): string | undefined {
	const normalizedHeaderName = headerName.toLowerCase();
	const match = Object.entries(headers).find(
		([name]) => name.toLowerCase() === normalizedHeaderName,
	);
	return match?.[1];
}

function normalizeSentryWebhookIssue(
	body: Record<string, unknown>,
): NormalizedSentryIssue | undefined {
	const data = objectValue(body.data);
	const issuePayload = objectValue(data?.issue);
	if (!issuePayload) {
		return undefined;
	}

	const eventPayload = objectValue(data?.event);
	const id = firstString(
		issuePayload.id,
		issuePayload.issue_id,
		eventPayload?.issue_id,
	);
	if (!id) {
		return undefined;
	}

	const projectSlug = firstString(
		objectValue(issuePayload.project)?.slug,
		objectValue(eventPayload?.project)?.slug,
		issuePayload.project,
		eventPayload?.project,
	);
	const projectName = firstString(
		objectValue(issuePayload.project)?.name,
		objectValue(eventPayload?.project)?.name,
		projectSlug,
	);

	return {
		id,
		title: firstString(
			issuePayload.title,
			issuePayload.short_id,
			eventPayload?.title,
			eventPayload?.message,
		),
		culprit: firstString(issuePayload.culprit, eventPayload?.culprit),
		level: firstString(issuePayload.level, eventPayload?.level),
		status: firstString(issuePayload.status, "unresolved"),
		project:
			projectSlug || projectName
				? {
						slug: projectSlug,
						name: projectName,
					}
				: undefined,
		count: firstNumberOrString(issuePayload.count, issuePayload.event_count),
		userCount: firstNumberOrString(
			issuePayload.userCount,
			issuePayload.user_count,
			issuePayload.users,
		),
		firstSeen: firstString(issuePayload.firstSeen, issuePayload.first_seen),
		lastSeen: firstString(
			issuePayload.lastSeen,
			issuePayload.last_seen,
			eventPayload?.datetime,
			eventPayload?.timestamp,
		),
		permalink: firstString(
			issuePayload.permalink,
			issuePayload.web_url,
			issuePayload.url,
			eventPayload?.web_url,
			eventPayload?.url,
		),
	};
}

function sentryDebugContextFromEvent(
	event: JsonRecord | undefined,
): SentryDebugContext | undefined {
	if (!event) {
		return undefined;
	}

	const tags = normalizeSentryTags(event.tags);
	const contexts = objectValue(event.contexts) ?? objectValue(event.context);
	const browserContext = objectValue(contexts?.browser);
	const osContext = objectValue(contexts?.os);
	const runtimeContext = objectValue(contexts?.runtime);
	const traceContext = objectValue(contexts?.trace);
	const user = objectValue(event.user);
	const topFrame = sentryTopStackFrame(event);
	const tagSummary = formatSentryTags(tags);
	const contextSummary = formatSentryContextSummary(contexts);

	return {
		environment: getSentryTag(tags, "environment"),
		release: firstString(event.release, getSentryTag(tags, "release")),
		transaction: firstString(
			getSentryTag(tags, "transaction"),
			traceContext?.transaction,
		),
		platform: firstString(event.platform),
		browser: firstString(
			getSentryTag(tags, "browser"),
			browserContext?.name,
			formatSentryContextName(browserContext),
		),
		os: firstString(
			getSentryTag(tags, "os"),
			osContext?.name,
			formatSentryContextName(osContext),
		),
		runtime: firstString(
			getSentryTag(tags, "runtime"),
			runtimeContext?.name,
			formatSentryContextName(runtimeContext),
		),
		latestEventId: firstString(event.eventID, event.event_id, event.id),
		latestEventTime: firstString(
			event.dateCreated,
			event.dateReceived,
			event.datetime,
			event.timestamp,
		),
		location: firstString(event.location, topFrame?.location),
		topStackFrame: topFrame?.summary,
		tags: tagSummary,
		user: formatSentryUser(user),
		contextSummary,
		rawContext: {
			message: firstString(event.message, event.title),
			exception: sentryExceptionSummary(event),
			tags,
			contexts,
			metadata: objectValue(event.metadata),
		},
	};
}

function normalizeSentryTags(value: unknown): SentryTag[] {
	if (Array.isArray(value)) {
		return value
			.map((tag) => {
				const record = objectValue(tag);
				return record
					? {
							key: stringValue(record.key),
							value: stringValue(record.value),
						}
					: undefined;
			})
			.filter(
				(tag): tag is { key: string; value: string } => Boolean(tag?.key),
			);
	}

	const record = objectValue(value);
	return Object.entries(record ?? {}).map(([key, tagValue]) => ({
		key,
		value: stringValue(tagValue),
	}));
}

function getSentryTag(tags: SentryTag[], key: string): string | undefined {
	return tags.find((tag) => tag.key === key)?.value;
}

function formatSentryTags(tags: SentryTag[]): string {
	return tags
		.filter((tag) => tag.key && tag.value)
		.map((tag) => `${tag.key}: ${tag.value}`)
		.join("\n");
}

function formatSentryContextName(context: JsonRecord | undefined): string {
	return compact([
		stringValue(context?.name),
		stringValue(context?.version),
		stringValue(context?.raw_description),
	]).join(" ");
}

function formatSentryContextSummary(
	contexts: JsonRecord | undefined,
): string | undefined {
	if (!contexts) {
		return undefined;
	}

	return Object.entries(contexts)
		.map(([name, context]) => {
			const record = objectValue(context);
			const label = formatSentryContextName(record);
			return label ? `${name}: ${label}` : name;
		})
		.join("\n");
}

function formatSentryUser(user: JsonRecord | undefined): string {
	if (!user) {
		return "";
	}

	return compact([
		stringValue(user.email),
		stringValue(user.username),
		stringValue(user.name),
		stringValue(user.id),
		stringValue(user.ip_address),
	]).join(" | ");
}

function sentryTopStackFrame(
	event: JsonRecord,
): { summary: string; location: string } | undefined {
	const frames = sentryStackFrames(event);
	if (frames.length === 0) {
		return undefined;
	}

	const frame =
		[...frames].reverse().find((candidate) => candidate.inApp) ??
		frames[frames.length - 1];
	const location = compact([
		frame.filename ?? frame.absPath,
		frame.lineno ? String(frame.lineno) : undefined,
		frame.colno ? String(frame.colno) : undefined,
	]).join(":");
	const summary = compact([
		frame.function,
		location,
		frame.module ? `(${frame.module})` : undefined,
	]).join(" ");

	return {
		summary: summary || location,
		location,
	};
}

function sentryStackFrames(event: JsonRecord): SentryStackFrame[] {
	const entries = arrayValue(event.entries);
	const exceptionEntry = entries
		.map(objectValue)
		.find((entry) => stringValue(entry?.type) === "exception");
	const exceptionData = objectValue(exceptionEntry?.data);
	const values = arrayValue(exceptionData?.values);
	const frames: SentryStackFrame[] = [];

	for (const value of values) {
		const stacktrace = objectValue(objectValue(value)?.stacktrace);
		for (const frameValue of arrayValue(stacktrace?.frames)) {
			const frame = objectValue(frameValue);
			if (!frame) {
				continue;
			}
			frames.push({
				filename: firstString(frame.filename, frame.filename_abs),
				absPath: firstString(frame.abs_path, frame.absPath),
				function: firstString(frame.function, frame.function_name),
				module: firstString(frame.module),
				lineno: numberValue(frame.lineno),
				colno: numberValue(frame.colno),
				inApp: Boolean(frame.in_app ?? frame.inApp),
			});
		}
	}

	return frames;
}

function sentryExceptionSummary(event: JsonRecord): string {
	const entries = arrayValue(event.entries);
	const exceptionEntry = entries
		.map(objectValue)
		.find((entry) => stringValue(entry?.type) === "exception");
	const values = arrayValue(objectValue(exceptionEntry?.data)?.values);
	const summaries = values
		.map((value) => {
			const exception = objectValue(value);
			return compact([
				stringValue(exception?.type),
				stringValue(exception?.value),
			]).join(": ");
		})
		.filter(Boolean);

	return summaries.join("\n");
}

worker.sync("granolaNotesBackfill", {
	database: granolaNotes,
	mode: "replace",
	schedule: "manual",
	execute: async (state: GranolaBackfillState | undefined, { notion }) => {
		const token = requireEnv("GRANOLA_API_KEY");
		const includeTranscript = process.env.GRANOLA_INCLUDE_TRANSCRIPT === "true";
		const notionClient = notion as unknown as NotionClientLike;
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			requireEnv("NOTION_API_TOKEN"),
			granolaNotionTargetId(),
		);
		const schema = await ensureGranolaNotionSchema(notionClient, dataSourceId);

		const page = await fetchGranolaNotesPage(token, { cursor: state?.cursor });
		const notes = await fetchGranolaNotes(page.notes, token, includeTranscript);
		await upsertGranolaNotePages(notionClient, dataSourceId, notes, schema);

		return {
			changes: [],
			hasMore: page.hasMore,
			nextState:
				page.hasMore && page.cursor ? { cursor: page.cursor } : undefined,
		};
	},
});

worker.sync("granolaNotesDelta", {
	database: granolaNotes,
	mode: "incremental",
	schedule: "5m",
	execute: async (state: GranolaDeltaState | undefined, { notion }) => {
		const token = requireEnv("GRANOLA_API_KEY");
		const includeTranscript = process.env.GRANOLA_INCLUDE_TRANSCRIPT === "true";
		const updatedAfter =
			state?.updatedAfter ?? bufferedGranolaDeltaCursor(new Date());
		const notionClient = notion as unknown as NotionClientLike;
		const dataSourceId = await resolveDataSourceId(
			notionClient,
			requireEnv("NOTION_API_TOKEN"),
			granolaNotionTargetId(),
		);
		const schema = await ensureGranolaNotionSchema(notionClient, dataSourceId);

		const page = await fetchGranolaNotesPage(token, {
			updatedAfter,
			cursor: state?.cursor,
		});
		const notes = await fetchGranolaNotes(page.notes, token, includeTranscript);
		const cycleMaxUpdatedAt = maxIsoDate(
			state?.cycleMaxUpdatedAt,
			...notes.map((note) => note.updated_at),
		);
		await upsertGranolaNotePages(notionClient, dataSourceId, notes, schema);

		return {
			changes: [],
			hasMore: page.hasMore,
			nextState:
				page.hasMore && page.cursor
					? {
							updatedAfter,
							cursor: page.cursor,
							cycleMaxUpdatedAt,
						}
					: {
							updatedAfter: nextGranolaDeltaCursor(
								updatedAfter,
								cycleMaxUpdatedAt,
							),
						},
		};
	},
});

async function fetchGranolaNotesPage(
	token: string,
	options: { cursor?: string; updatedAfter?: string },
): Promise<{
	notes: GranolaListNote[];
	hasMore: boolean;
	cursor: string | null;
}> {
	const listUrl = new URL("https://public-api.granola.ai/v1/notes");
	listUrl.searchParams.set("page_size", String(GRANOLA_PAGE_SIZE));
	if (options.cursor) {
		listUrl.searchParams.set("cursor", options.cursor);
	}
	if (options.updatedAfter) {
		listUrl.searchParams.set("updated_after", options.updatedAfter);
	}

	await granolaApi.wait();
	return fetchJson(
		listUrl,
		{
			headers: {
				Authorization: `Bearer ${token}`,
			},
		},
		"Granola notes list",
	);
}

async function fetchGranolaNotes(
	notes: GranolaListNote[],
	token: string,
	includeTranscript: boolean,
): Promise<GranolaNote[]> {
	return Promise.all(
		notes.map(async (note) => {
			await granolaApi.wait();
			return fetchGranolaNote(note.id, token, includeTranscript);
		}),
	);
}

type ThemeSources = {
	github: string[] | null;
	sentry: string[] | null;
	granola: string[] | null;
	slack: string[] | null;
	wiki: string[] | null;
};

type Theme = {
	name: string;
	type: string;
	summary: string;
	confidence: number | null;
	confidenceReasoning: string | null;
	momentum: string | null;
	stakeholders: string[] | null;
	sources: ThemeSources;
	insight: string | null;
	openQuestions: string[] | null;
	counterEvidence: string[] | null;
};

type Divergence = {
	observation: string;
	sources: string[] | null;
	hypothesis: string | null;
	whatToCheck: string | null;
};

type ForkItem = {
	action: string;
	owner: string;
	timing: string;
};

type Forecast = {
	dramaticEpigraph: string | null;
	snapshot: string;
	mischievousReading: string;
	radiantReading: string;
	fork: ForkItem[];
	mischievousImageUrl: string | null;
	radiantImageUrl: string | null;
};

const SOURCE_LABELS: Array<{ key: keyof ThemeSources; label: string }> = [
	{ key: "github", label: "GitHub" },
	{ key: "sentry", label: "Sentry" },
	{ key: "granola", label: "Granola" },
	{ key: "slack", label: "Slack" },
	{ key: "wiki", label: "Wiki" },
];

worker.tool("createSynthesis", {
	title: "Create Synthesis Page",
	description:
		"Publish a Notion synthesis page that names the implicit roadmap a team is building, by triangulating five sources: four Notion-synced execution streams (GitHub commits/PRs, Sentry issues, Granola meeting notes, Slack messages) plus the company Wiki (PRDs, Feature Specs, ADRs, Product Decision Records, Runbooks — the documented intent). The Custom Agent reads those sources directly, clusters cross-source signals into themes, names the divergences (especially intent-vs-execution gaps where the Wiki says one thing and execution shows another), and calls this tool with the result. This tool only renders the page; it does no reasoning.",
	schema: j.object({
		overview: j
			.string()
			.describe(
				"2 to 4 sentence executive summary of the period: what the implicit roadmap appears to be, what the strongest cross-source signal is, and where the agent has the least confidence. Use hedged language ('appears to', 'suggests', 'likely'). This renders as a callout at the top of the page.",
			),
		themes: j
			.array(
				j.object({
					name: j.string().describe("Theme name, 3 to 5 words."),
					type: j
						.string()
						.describe(
							'One of "feature", "refactor", "infrastructure", "exploration", "fix", "polish".',
						),
					summary: j
						.string()
						.describe(
							"1 to 3 sentences describing what is converging here. Hedge where the evidence is thin ('appears to', 'likely', 'suggests').",
						),
					confidence: j
						.number()
						.describe("0.0 to 1.0 confidence in this theme.")
						.nullable(),
					confidenceReasoning: j
						.string()
						.describe(
							"One sentence explaining why this confidence number, not just the number. Show your work: which sources reinforce, which are silent, what's ambiguous. Example: '0.85 — strong GitHub signal (8 commits, 2 PRs) plus a Granola mention; Sentry silent so no user pain confirmation.'",
						)
						.nullable(),
					momentum: j
						.string()
						.describe(
							"One short label for the direction of activity in this theme. Suggested vocabulary: 'rising', 'steady', 'cooling', 'dormant', 'emerging', 'finishing'. Pick what best matches the evidence.",
						)
						.nullable(),
					stakeholders: j
						.array(j.string())
						.describe(
							"Names of people involved across any source (GitHub actors, meeting attendees, Slack participants). Reveals concentration of ownership.",
						)
						.nullable(),
					sources: j
						.object({
							github: j
								.array(j.string())
								.describe(
									"Pre-formatted bullets for supporting GitHub events. Format: 'abc1234: fix OAuth redirect (alice)' or 'PR #42: tighten session storage (bob)'.",
								)
								.nullable(),
							sentry: j
								.array(j.string())
								.describe(
									"Pre-formatted bullets for related Sentry issues. Format: 'OAuth callback timeout (5 events, P1)'.",
								)
								.nullable(),
							granola: j
								.array(j.string())
								.describe(
									"Pre-formatted bullets for relevant Granola meeting notes. Format: 'Mon standup: auth issue raised by alice'.",
								)
								.nullable(),
							slack: j
								.array(j.string())
								.describe(
									"Pre-formatted bullets for relevant Slack messages. Format: '#eng-auth: 3 messages this week mentioning OAuth'.",
								)
								.nullable(),
							wiki: j
								.array(j.string())
								.describe(
									"Pre-formatted bullets for relevant Wiki pages (PRDs, Feature Specs, ADRs, Runbooks, Product/Engineering docs). Format: 'Feature Spec: Onboarding and Checkout (Draft) — names auth changes not yet in code' or 'Runbook: Sentry Triage — defines expected response to the OAuth alert climb'. Use this to surface intent-vs-execution gaps: documented expectations that reality is or isn't matching.",
								)
								.nullable(),
						})
						.describe(
							"Per-source supporting evidence. Pass null (not an empty array) for sources that have no signal for this theme.",
						),
					insight: j
						.string()
						.describe(
							"1 to 2 sentences of cross-source observation about this theme. Hedge claims you can't fully back. Example: 'Engineering appears to be actively closing this; the meeting cadence has dropped to one mention per week, which likely suggests it's near done rather than abandoned.'",
						)
						.nullable(),
					openQuestions: j
						.array(j.string())
						.describe(
							"1 to 3 hedged inferences or things a PM would want to verify. Each should explicitly hedge: 'Possibly X because Y, would confirm by checking Z.' These are the moments where the agent shows humility about what the data can support.",
						)
						.nullable(),
					counterEvidence: j
						.array(j.string())
						.describe(
							"Optional. 1 to 2 signals that disconfirm or complicate this theme, if any exist. Forces the agent to actively look for disconfirming evidence rather than only confirming. Pass null if there's none.",
						)
						.nullable(),
				}),
			)
			.describe(
				"The implicit roadmap: clusters of cross-source activity the agent inferred.",
			),
		divergences: j
			.array(
				j.object({
					observation: j
						.string()
						.describe(
							"One sentence naming a cross-source mismatch. Example: 'Granola mentions search v2 in 3 meetings, but no commits touch it.'",
						),
					sources: j
						.array(j.string())
						.describe(
							"Which source names are involved, e.g. ['Granola', 'GitHub']. Optional.",
						)
						.nullable(),
					hypothesis: j
						.string()
						.describe(
							"Optional. One short hedged guess at why this divergence exists. Example: 'Possibly because the work was scoped out in planning but not formally cancelled.'",
						)
						.nullable(),
					whatToCheck: j
						.string()
						.describe(
							"Optional. One specific verification step a PM could take. Example: 'Worth confirming with @alice whether search v2 is still committed for this quarter.'",
						)
						.nullable(),
				}),
			)
			.describe(
				"Top-level mismatches between sources. This is the lean-forward beat of the synthesis: things the work isn't matching the talk, or vice versa.",
			)
			.nullable(),
		forecast: j
			.object({
				dramaticEpigraph: j
					.string()
					.describe(
						"Optional one-line dramatic quote rendered as a banner above the fork diagram. Should land between portentous and tongue-in-cheek — think Dante's 'Abandon all hope, ye who enter here' energy but specific to this synthesis. Reference what's actually in the snapshot. Under 15 words. Pass null to skip.",
					)
					.nullable(),
				snapshot: j
					.string()
					.describe(
						"Two to three sentences of factual current state across the most active workstreams. Prose, not bullets. Specific numbers where the evidence supports them. This is the unified preamble both readings work from.",
					),
				mischievousReading: j
					.string()
					.describe(
						"Exactly four short paragraphs (separated by blank lines) in the voice of a slightly seductive observer delighted by patterns of dysfunction. EACH PARAGRAPH MUST BEGIN with a 🔥 emoji and a milestone label, formatted exactly as: '🔥 Weeks: ', '🔥 Months: ', '🔥 Quarter: ', '🔥 Year-end: '. Stepped detail across paragraphs. Paragraph 1 (🔥 Weeks): the next 1-2 weeks, grounded, specific, plausibly accurate, what a senior engineer would nod at. Paragraph 2 (🔥 Months): the next 1-2 months, slightly zoomed out but still concrete, patterns of avoidance and re-debate. Paragraph 3 (🔥 Quarter): comic-grotesque register — haunted branches, sole maintainers muttering, words nobody says anymore. Paragraph 4 (🔥 Year-end): minimal detail, maximum theme, folkloric and mythological. Reference items by name throughout. Mention dysfunction types (unwritten, unowned, drifting, single-author, oscillating, dropped) sparingly — at most three across both readings combined. NEVER accuse a named person of a character flaw — predict systems failing, not people.",
					),
				radiantReading: j
					.string()
					.describe(
						"Exactly four short paragraphs (separated by blank lines) in the voice of a gracious observer seeing the version where small interventions land. EACH PARAGRAPH MUST BEGIN with a ☁️ emoji and a milestone label, formatted exactly as: '☁️ Weeks: ', '☁️ Months: ', '☁️ Quarter: ', '☁️ Year-end: '. Stepped detail matching the four heaven-path milestones (clarity, cadence, blessed, Paradiso). Address the same items as the Mischievous Reading, by name. Each prediction grounded in a reachable action by a specific actor on a specific timing. Never preachy. Long-horizon register: rapturous (ADRs becoming legend, new engineers weeping with gratitude, the codebase reads like scripture).",
					),
				fork: j
					.array(
						j.object({
							action: j
								.string()
								.describe(
									"The intervention. Under 20 words. Verb-led and specific.",
								),
							owner: j
								.string()
								.describe('Named person, or "needs an owner".'),
							timing: j
								.string()
								.describe(
									'Specific timing such as "by Tuesday", "this week", or "before next standup".',
								),
						}),
					)
					.describe(
						"Three to five concrete interventions that make the Radiant Reading manifest. Each specific enough to put on a calendar.",
					),
				mischievousImageUrl: j
					.string()
					.describe(
						"Optional public image URL to show alongside the Mischievous Reading. Defaults to a Gustave Doré Inferno illustration. Use any public-domain, GIF, or workplace-safe image URL you like.",
					)
					.nullable(),
				radiantImageUrl: j
					.string()
					.describe(
						"Optional public image URL to show alongside the Radiant Reading. Defaults to a Gustave Doré Paradiso illustration.",
					)
					.nullable(),
			})
			.describe(
				"Optional heaven/hell forecast. The snapshot is shared between both readings. Both readings escalate from grounded near-term to mythological long-term. Pass null to omit the entire forecast section.",
			)
			.nullable(),
		title: j
			.string()
			.describe(
				"ALMOST ALWAYS pass null here — the default 'Two Roads — May 17, 2026' format is what we want. Only override with a custom title if explicitly asked. Never use event-specific titles like 'Launch Eve' or 'Q3 Kickoff' — the page is evergreen synthesis, not a single-event recap.",
			)
			.nullable(),
		windowDescription: j
			.string()
			.describe(
				"Human-readable description of the time window the agent analyzed, e.g. 'last 7 days', 'all available activity'. Shown in the page header.",
			)
			.nullable(),
	}),
	outputSchema: j.object({
		pageId: j.string(),
		url: j.string(),
		themeCount: j.number(),
		divergenceCount: j.number(),
	}),
	execute: async (
		{ overview, themes, divergences, forecast, title, windowDescription },
		{ notion },
	) => {
		const parentPageId = requireEnv("SYNTHESIS_PARENT_PAGE_ID");
		const pageTitle = title ?? defaultSynthesisTitle();
		const window = windowDescription ?? "the recent window";
		const divergenceList = divergences ?? [];

		// If a forecast is provided, resolve the two reading images. By default
		// we upload the bundled heaven.gif / hell.gif via Notion file uploads;
		// the agent can override per-call with mischievousImageUrl / radiantImageUrl.
		let forecastImages: ForecastImages | null = null;
		if (forecast) {
			const [mischievous, radiant] = await Promise.all([
				resolveForecastImage(
					notion,
					forecast.mischievousImageUrl,
					"hell.gif",
					DEFAULT_MISCHIEVOUS_IMAGE_URL,
				),
				resolveForecastImage(
					notion,
					forecast.radiantImageUrl,
					"heaven.gif",
					DEFAULT_RADIANT_IMAGE_URL,
				),
			]);
			forecastImages = { mischievous, radiant };
		}

		const page = await notion.pages.create({
			parent: { page_id: parentPageId },
			properties: {
				title: {
					title: [{ type: "text", text: { content: pageTitle } }],
				},
			},
			children: synthesisBlocks(
				pageTitle,
				overview,
				themes,
				divergenceList,
				window,
				forecast ?? null,
				forecastImages,
			),
		});

		return {
			pageId: page.id,
			url: (page as { url?: string }).url ?? "",
			themeCount: themes.length,
			divergenceCount: divergenceList.length,
		};
	},
});

function synthesisBlocks(
	_pageTitle: string,
	_overview: string,
	themes: Theme[],
	divergences: Divergence[],
	_windowDescription: string,
	forecast: Forecast | null,
	forecastImages: ForecastImages | null,
): BlockObjectRequest[] {
	// Page is the heaven/hell. Order from top:
	//   1. Epigraph callout (the hook)
	//   2. Mermaid fork diagram (visual heaven/hell)
	//   3. Side-by-side Mischievous / Radiant readings (the narratives)
	//   4. Snapshot callout (compact context)
	//   5. What to do right now (fork to-dos)
	//   6. Toggle h2: Divergences (collapsed)
	//   7. Toggle h2: Implicit roadmap (collapsed)
	const blocks: BlockObjectRequest[] = [];

	if (forecast) {
		blocks.push(...forecastTopBlocks(forecast, forecastImages));
	}

	if (divergences.length > 0) {
		blocks.push(
			toggleHeading2(
				"🔍 Where the signals diverge",
				divergencesInner(divergences),
			),
		);
	}

	if (themes.length > 0) {
		blocks.push(
			toggleHeading2("🗺 The implicit roadmap", themesInner(themes)),
		);
	}

	return blocks;
}

// Inner content for the divergences toggle. Each divergence is one bullet
// with the observation; hypothesis and what-to-check become sub-bullets
// underneath, kept compact.
function divergencesInner(divergences: Divergence[]): BlockObjectRequest[] {
	const blocks: BlockObjectRequest[] = [];
	for (const d of divergences) {
		const sources = (d.sources ?? []).filter(Boolean);
		const tail = sources.length > 0 ? ` (${sources.join(" / ")})` : "";
		const children: BlockObjectRequest[] = [];
		if (d.hypothesis) {
			children.push(bullet(`Hypothesis: ${d.hypothesis}`));
		}
		if (d.whatToCheck) {
			children.push(bullet(`Worth checking: ${d.whatToCheck}`));
		}
		blocks.push(
			bullet(
				`${d.observation}${tail}`,
				children.length > 0 ? children : undefined,
			),
		);
	}
	return blocks;
}

// Inner content for the implicit roadmap toggle. Each theme becomes a
// toggle-h3 of its own, so readers can open the one they care about
// without unfurling everything.
function themesInner(themes: Theme[]): BlockObjectRequest[] {
	const blocks: BlockObjectRequest[] = [];
	for (const theme of themes) {
		// Compact heading: name plus the at-a-glance attributes inline.
		const headerParts: string[] = [`Type: ${theme.type}`];
		if (typeof theme.confidence === "number") {
			headerParts.push(`Confidence: ${theme.confidence.toFixed(2)}`);
		}
		if (theme.momentum) {
			headerParts.push(`Momentum: ${theme.momentum}`);
		}
		const heading = `${theme.name}  ·  ${headerParts.join("  ·  ")}`;

		const themeBody: BlockObjectRequest[] = [];

		if (theme.confidenceReasoning) {
			themeBody.push(
				paragraph(`Confidence reasoning: ${theme.confidenceReasoning}`),
			);
		}
		if (theme.summary) {
			themeBody.push(paragraph(theme.summary));
		}
		if (theme.insight) {
			themeBody.push(callout(theme.insight, "🔍"));
		}
		if (theme.stakeholders && theme.stakeholders.length > 0) {
			themeBody.push(
				paragraph(`Stakeholders: ${theme.stakeholders.join(", ")}`),
			);
		}
		if (theme.openQuestions && theme.openQuestions.length > 0) {
			themeBody.push(paragraph("Open questions:"));
			for (const q of theme.openQuestions) {
				themeBody.push(bullet(q));
			}
		}
		if (theme.counterEvidence && theme.counterEvidence.length > 0) {
			themeBody.push(paragraph("Counter-evidence:"));
			for (const c of theme.counterEvidence) {
				themeBody.push(bullet(c));
			}
		}

		const populatedSources = SOURCE_LABELS.filter(({ key }) => {
			const list = theme.sources?.[key];
			return Array.isArray(list) && list.length > 0;
		});
		if (populatedSources.length > 0) {
			themeBody.push(paragraph("Supporting signals by source:"));
			// Flat bullets only — Notion caps create-time nesting at 2 child
			// levels, and we're already inside a toggle h2 + toggle h3. Use
			// the label-then-items pattern with the label as a paragraph so
			// the items still read like a grouped list.
			for (const { key, label } of populatedSources) {
				const items = (theme.sources[key] ?? []).filter(Boolean);
				themeBody.push(paragraph(`${label} (${items.length}):`));
				for (const item of items) {
					themeBody.push(bullet(item));
				}
			}
		}

		blocks.push(toggleHeading3(heading, themeBody));
	}
	return blocks;
}

// ============================================================================
// read* tools — bulk-fetch synced substrate with full page bodies parsed
// ============================================================================
//
// The Notion Custom Agent calls these once per source to get all the recent
// data in a single structured payload, rather than opening pages individually.
// The agent does the cross-source clustering; these tools do the mechanical
// page-body reads and JSON parsing the agent shouldn't waste tokens on.

type ParsedBody = {
	markdown: string;
	codeBlocks: Array<{ language: string; content: string }>;
};

async function readPageBody(notion: Client, pageId: string): Promise<ParsedBody> {
	const lines: string[] = [];
	const codeBlocks: Array<{ language: string; content: string }> = [];

	let cursor: string | undefined;
	do {
		const response = await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});

		for (const block of response.results) {
			if (!isFullBlock(block)) continue;

			switch (block.type) {
				case "paragraph": {
					lines.push(richTextToString(block.paragraph.rich_text));
					break;
				}
				case "heading_1": {
					lines.push(`# ${richTextToString(block.heading_1.rich_text)}`);
					break;
				}
				case "heading_2": {
					lines.push(`## ${richTextToString(block.heading_2.rich_text)}`);
					break;
				}
				case "heading_3": {
					lines.push(`### ${richTextToString(block.heading_3.rich_text)}`);
					break;
				}
				case "bulleted_list_item": {
					lines.push(
						`- ${richTextToString(block.bulleted_list_item.rich_text)}`,
					);
					break;
				}
				case "numbered_list_item": {
					lines.push(
						`1. ${richTextToString(block.numbered_list_item.rich_text)}`,
					);
					break;
				}
				case "code": {
					const content = richTextToString(block.code.rich_text);
					const language = block.code.language ?? "plain";
					codeBlocks.push({ language, content });
					lines.push("```" + language);
					lines.push(content);
					lines.push("```");
					break;
				}
				case "callout": {
					lines.push(`> ${richTextToString(block.callout.rich_text)}`);
					break;
				}
				case "quote": {
					lines.push(`> ${richTextToString(block.quote.rich_text)}`);
					break;
				}
				case "divider": {
					lines.push("---");
					break;
				}
				default: {
					break;
				}
			}
		}

		if (!response.has_more || !response.next_cursor) break;
		cursor = response.next_cursor;
	} while (cursor);

	return { markdown: lines.join("\n"), codeBlocks };
}

function richTextToString(items: Array<{ plain_text?: string }>): string {
	return items.map((r) => r.plain_text ?? "").join("");
}

function readPropertyValue(prop: unknown): string | number | boolean | null {
	const record = objectValue(prop);
	if (!record) return null;
	const type = stringValue(record.type);

	switch (type) {
		case "title":
			return richTextToString(
				arrayValue(record.title) as Array<{ plain_text?: string }>,
			);
		case "rich_text":
			return richTextToString(
				arrayValue(record.rich_text) as Array<{ plain_text?: string }>,
			);
		case "number":
			return typeof record.number === "number" ? record.number : null;
		case "checkbox":
			return typeof record.checkbox === "boolean" ? record.checkbox : null;
		case "date": {
			const date = objectValue(record.date);
			return date ? stringValue(date.start) : null;
		}
		case "select": {
			const sel = objectValue(record.select);
			return sel ? stringValue(sel.name) : null;
		}
		case "multi_select":
			return arrayValue(record.multi_select)
				.map((m) => stringValue(objectValue(m)?.name))
				.filter(Boolean)
				.join(", ");
		case "status": {
			const s = objectValue(record.status);
			return s ? stringValue(s.name) : null;
		}
		case "url":
			return stringValue(record.url);
		case "email":
			return stringValue(record.email);
		case "phone_number":
			return stringValue(record.phone_number);
		case "created_time":
			return stringValue(record.created_time);
		case "last_edited_time":
			return stringValue(record.last_edited_time);
		case "people":
			return arrayValue(record.people)
				.map((p) => {
					const person = objectValue(p);
					return (
						stringValue(person?.name) || stringValue(person?.id)
					);
				})
				.filter(Boolean)
				.join(", ");
		case "files":
			return arrayValue(record.files)
				.map((f) => stringValue(objectValue(f)?.name))
				.filter(Boolean)
				.join(", ");
		default:
			return null;
	}
}

function queryPropertyValue(
	properties: JsonRecord | undefined,
	name: string,
): string | number | boolean | null {
	if (!properties) return null;
	return readPropertyValue(properties[name]);
}

function pageProperties(page: unknown): JsonRecord | undefined {
	const record = objectValue(page);
	return record ? objectValue(record.properties) : undefined;
}

function pageId(page: unknown): string {
	return stringValue(objectValue(page)?.id);
}

function findFirstJsonPayload(
	codeBlocks: Array<{ language: string; content: string }>,
): JsonRecord | undefined {
	const json = codeBlocks.find(
		(c) => c.language === "json" || c.language === "plain",
	);
	if (!json) return undefined;
	try {
		const cleaned = json.content.replace(/\n\.\.\. truncated$/, "");
		return objectValue(JSON.parse(cleaned));
	} catch {
		return undefined;
	}
}

// ---------- readGithubActivity ---------------------------------------------

worker.tool("readGithubActivity", {
	title: "Read GitHub Activity",
	description:
		"Fetch recent issues and pull requests from the GitHub Notion database (populated by Notion's GitHub connector) with page bodies. Returns structured records with title, type, author, repo, state, merged/draft status, labels, dates, and the full body markdown. The Notion Custom Agent calls this to get rich GitHub substrate for theme clustering.",
	schema: j.object({
		sinceDays: j
			.number()
			.describe("Look back N days by Created Time. Defaults to 90, cap 90.")
			.nullable(),
		limit: j
			.number()
			.describe("Max rows to fetch. Defaults to 200, cap 200.")
			.nullable(),
		types: j
			.array(j.string())
			.describe(
				"GitHub item types to include, e.g. ['Pull Request', 'Issue']. If omitted, returns all types.",
			)
			.nullable(),
	}),
	outputSchema: j.object({
		items: j.array(
			j.object({
				id: j.string(),
				title: j.string(),
				type: j.string(),
				author: j.string(),
				repoFullName: j.string(),
				number: j.number(),
				state: j.string(),
				stateReason: j.string(),
				merged: j.boolean(),
				draft: j.boolean(),
				labels: j.string(),
				assignees: j.string(),
				milestone: j.string(),
				createdAt: j.string(),
				updatedAt: j.string(),
				closedAt: j.string(),
				comments: j.number(),
				additions: j.number(),
				deletions: j.number(),
				changedFiles: j.number(),
				url: j.string(),
				bodyMarkdown: j.string(),
			}),
		),
		totalReturned: j.number(),
	}),
	execute: async ({ sinceDays, limit, types }, { notion }) => {
		const dataSourceId = requireEnv("GITHUB_ACTIVITY_DATA_SOURCE_ID");
		const lookback = Math.min(sinceDays ?? 90, 90);
		const max = Math.min(limit ?? 200, 200);
		const since = new Date(
			Date.now() - lookback * 86_400_000,
		).toISOString();

		const filter: Record<string, unknown> = {
			and: [{ property: "Created Time", date: { on_or_after: since } }],
		};
		if (types && types.length > 0) {
			(filter.and as unknown[]).push({
				or: types.map((t) => ({
					property: "Type",
					rich_text: { equals: t },
				})),
			});
		}

		const items: Array<NonNullable<ReturnType<typeof parseGithubItem>>> = [];
		let cursor: string | undefined;
		while (items.length < max) {
			const response = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: filter as never,
				sorts: [{ property: "Created Time", direction: "descending" }],
				page_size: Math.min(100, max - items.length),
				start_cursor: cursor,
			});

			for (const page of response.results) {
				const id = pageId(page);
				if (!id) continue;
				const properties = pageProperties(page);
				if (!properties) continue;
				const body = await readPageBody(notion, id);
				const item = parseGithubItem(properties, body);
				if (item) items.push(item);
				if (items.length >= max) break;
			}

			if (!response.has_more || !response.next_cursor) break;
			cursor = response.next_cursor;
		}

		return {
			items,
			totalReturned: items.length,
		};
	},
});

// Parser for rows in the Notion GitHub connector schema (issues + pull requests).
// Schema reference (from the live "Data Sources / GitHub" tab):
//   GitHub Item ID, Name (title), Type, Author, Repo Full Name, Number,
//   State, State Reason, Merged, Draft, Labels, Assignees, Milestone,
//   Created Time, Updated Time, Closed Time, Comments,
//   Additions, Deletions, Changed Files, URL
function parseGithubItem(
	properties: JsonRecord,
	body: ParsedBody,
): {
	id: string;
	title: string;
	type: string;
	author: string;
	repoFullName: string;
	number: number;
	state: string;
	stateReason: string;
	merged: boolean;
	draft: boolean;
	labels: string;
	assignees: string;
	milestone: string;
	createdAt: string;
	updatedAt: string;
	closedAt: string;
	comments: number;
	additions: number;
	deletions: number;
	changedFiles: number;
	url: string;
	bodyMarkdown: string;
} | null {
	const id = stringValue(queryPropertyValue(properties, "GitHub Item ID"));
	if (!id) return null;

	const numberRaw = queryPropertyValue(properties, "Number");
	const commentsRaw = queryPropertyValue(properties, "Comments");
	const additionsRaw = queryPropertyValue(properties, "Additions");
	const deletionsRaw = queryPropertyValue(properties, "Deletions");
	const changedFilesRaw = queryPropertyValue(properties, "Changed Files");
	const mergedRaw = queryPropertyValue(properties, "Merged");
	const draftRaw = queryPropertyValue(properties, "Draft");

	return {
		id,
		title: stringValue(queryPropertyValue(properties, "Name")),
		type: stringValue(queryPropertyValue(properties, "Type")),
		author: stringValue(queryPropertyValue(properties, "Author")),
		repoFullName: stringValue(
			queryPropertyValue(properties, "Repo Full Name"),
		),
		number: typeof numberRaw === "number" ? numberRaw : 0,
		state: stringValue(queryPropertyValue(properties, "State")),
		stateReason: stringValue(queryPropertyValue(properties, "State Reason")),
		merged: mergedRaw === true,
		draft: draftRaw === true,
		labels: stringValue(queryPropertyValue(properties, "Labels")),
		assignees: stringValue(queryPropertyValue(properties, "Assignees")),
		milestone: stringValue(queryPropertyValue(properties, "Milestone")),
		createdAt: stringValue(queryPropertyValue(properties, "Created Time")),
		updatedAt: stringValue(queryPropertyValue(properties, "Updated Time")),
		closedAt: stringValue(queryPropertyValue(properties, "Closed Time")),
		comments: typeof commentsRaw === "number" ? commentsRaw : 0,
		additions: typeof additionsRaw === "number" ? additionsRaw : 0,
		deletions: typeof deletionsRaw === "number" ? deletionsRaw : 0,
		changedFiles:
			typeof changedFilesRaw === "number" ? changedFilesRaw : 0,
		url: stringValue(queryPropertyValue(properties, "URL")),
		bodyMarkdown: body.markdown,
	};
}

// ---------- readSentryIssues -----------------------------------------------

worker.tool("readSentryIssues", {
	title: "Read Sentry Issues",
	description:
		"Fetch recent rows from the Sentry Issues Notion database. Returns structured issue records with culprit, level, status, counts, and dates. Useful for the Notion Custom Agent when reasoning about user-facing pain alongside other sources.",
	schema: j.object({
		sinceDays: j
			.number()
			.describe(
				"Look back N days based on Last Seen. Defaults to 30, cap 90.",
			)
			.nullable(),
		limit: j
			.number()
			.describe("Max rows to fetch. Defaults to 30, cap 200.")
			.nullable(),
		levels: j
			.array(j.string())
			.describe(
				"Sentry levels to include, e.g. ['error', 'fatal']. If omitted, returns all levels.",
			)
			.nullable(),
	}),
	outputSchema: j.object({
		issues: j.array(
			j.object({
				id: j.string(),
				title: j.string(),
				culprit: j.string(),
				level: j.string(),
				status: j.string(),
				project: j.string(),
				userCount: j.number(),
				eventCount: j.number(),
				firstSeen: j.string(),
				lastSeen: j.string(),
				permalink: j.string(),
				bodyMarkdown: j.string(),
			}),
		),
		totalReturned: j.number(),
	}),
	execute: async ({ sinceDays, limit, levels }, { notion }) => {
		const dataSourceId = requireEnv("SENTRY_ISSUES_DATA_SOURCE_ID");
		const lookback = Math.min(sinceDays ?? 90, 90);
		const max = Math.min(limit ?? 200, 200);
		const since = new Date(
			Date.now() - lookback * 86_400_000,
		).toISOString();

		const filter: Record<string, unknown> = {
			and: [{ property: "Last Seen", date: { on_or_after: since } }],
		};
		if (levels && levels.length > 0) {
			(filter.and as unknown[]).push({
				or: levels.map((l) => ({
					property: "Level",
					rich_text: { equals: l },
				})),
			});
		}

		const issues: Array<{
			id: string;
			title: string;
			culprit: string;
			level: string;
			status: string;
			project: string;
			userCount: number;
			eventCount: number;
			firstSeen: string;
			lastSeen: string;
			permalink: string;
			bodyMarkdown: string;
		}> = [];
		let cursor: string | undefined;

		while (issues.length < max) {
			const response = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: filter as never,
				sorts: [{ property: "Last Seen", direction: "descending" }],
				page_size: Math.min(100, max - issues.length),
				start_cursor: cursor,
			});

			for (const page of response.results) {
				const id = pageId(page);
				if (!id) continue;
				const properties = pageProperties(page);
				if (!properties) continue;
				const sentryId = stringValue(
					queryPropertyValue(properties, "Sentry Issue ID"),
				);
				if (!sentryId) continue;
				const body = await readPageBody(notion, id);
				const userCount = queryPropertyValue(properties, "User Count");
				const eventCount = queryPropertyValue(properties, "Event Count");

				issues.push({
					id: sentryId,
					title: stringValue(queryPropertyValue(properties, "Issue")),
					culprit: stringValue(queryPropertyValue(properties, "Culprit")),
					level: stringValue(queryPropertyValue(properties, "Level")),
					status: stringValue(queryPropertyValue(properties, "Status")),
					project: stringValue(queryPropertyValue(properties, "Project")),
					userCount: typeof userCount === "number" ? userCount : 0,
					eventCount: typeof eventCount === "number" ? eventCount : 0,
					firstSeen: stringValue(
						queryPropertyValue(properties, "First Seen"),
					),
					lastSeen: stringValue(
						queryPropertyValue(properties, "Last Seen"),
					),
					permalink: stringValue(
						queryPropertyValue(properties, "Permalink"),
					),
					bodyMarkdown: body.markdown,
				});

				if (issues.length >= max) break;
			}

			if (!response.has_more || !response.next_cursor) break;
			cursor = response.next_cursor;
		}

		return { issues, totalReturned: issues.length };
	},
});

// ---------- readGranolaNotes -----------------------------------------------

worker.tool("readGranolaNotes", {
	title: "Read Granola Notes",
	description:
		"Fetch recent rows from the Granola Notes Notion database with full page bodies. Returns structured note records with owner, attendees, meeting time, summary, action items, and the full body markdown (optionally including transcript content if the sync stored it).",
	schema: j.object({
		sinceDays: j
			.number()
			.describe(
				"Look back N days based on Meeting Time. Defaults to 30, cap 180.",
			)
			.nullable(),
		limit: j
			.number()
			.describe("Max rows to fetch. Defaults to 20, cap 100.")
			.nullable(),
	}),
	outputSchema: j.object({
		notes: j.array(
			j.object({
				id: j.string(),
				title: j.string(),
				owner: j.string(),
				attendees: j.string(),
				meetingTime: j.string(),
				summary: j.string(),
				actionItems: j.string(),
				updatedTime: j.string(),
				webUrl: j.string(),
				bodyMarkdown: j.string(),
			}),
		),
		totalReturned: j.number(),
	}),
	execute: async ({ sinceDays, limit }, { notion }) => {
		const dataSourceId = requireEnv("GRANOLA_NOTES_DATA_SOURCE_ID");
		const lookback = Math.min(sinceDays ?? 180, 180);
		const max = Math.min(limit ?? 100, 100);
		const since = new Date(
			Date.now() - lookback * 86_400_000,
		).toISOString();

		const notes: Array<{
			id: string;
			title: string;
			owner: string;
			attendees: string;
			meetingTime: string;
			summary: string;
			actionItems: string;
			updatedTime: string;
			webUrl: string;
			bodyMarkdown: string;
		}> = [];
		let cursor: string | undefined;

		while (notes.length < max) {
			const response = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: {
					property: "Meeting Time",
					date: { on_or_after: since },
				} as never,
				sorts: [{ property: "Meeting Time", direction: "descending" }],
				page_size: Math.min(100, max - notes.length),
				start_cursor: cursor,
			});

			for (const page of response.results) {
				const id = pageId(page);
				if (!id) continue;
				const properties = pageProperties(page);
				if (!properties) continue;
				const noteId = stringValue(
					queryPropertyValue(properties, "Granola Note ID"),
				);
				if (!noteId) continue;
				const body = await readPageBody(notion, id);

				notes.push({
					id: noteId,
					title: stringValue(queryPropertyValue(properties, "Note")),
					owner: stringValue(queryPropertyValue(properties, "Owner")),
					attendees: stringValue(
						queryPropertyValue(properties, "Attendees"),
					),
					meetingTime: stringValue(
						queryPropertyValue(properties, "Meeting Time"),
					),
					summary: stringValue(
						queryPropertyValue(properties, "Summary"),
					),
					actionItems: stringValue(
						queryPropertyValue(properties, "Action Items"),
					),
					updatedTime: stringValue(
						queryPropertyValue(properties, "Updated Time"),
					),
					webUrl: stringValue(queryPropertyValue(properties, "Web URL")),
					bodyMarkdown: body.markdown,
				});

				if (notes.length >= max) break;
			}

			if (!response.has_more || !response.next_cursor) break;
			cursor = response.next_cursor;
		}

		return { notes, totalReturned: notes.length };
	},
});

// ---------- readSlackMessages (generic, schema-agnostic) -------------------

worker.tool("readSlackMessages", {
	title: "Read Slack Messages",
	description:
		"Fetch recent rows from the Slack-synced Notion database. Because the Slack DB is a Notion-managed connector whose schema we don't own, properties are returned generically as name/value pairs along with the full page body markdown. The agent decides what to use.",
	schema: j.object({
		limit: j
			.number()
			.describe("Max rows to fetch. Defaults to 50, cap 200.")
			.nullable(),
	}),
	outputSchema: j.object({
		messages: j.array(
			j.object({
				id: j.string(),
				properties: j.array(
					j.object({
						name: j.string(),
						value: j.string(),
					}),
				),
				bodyMarkdown: j.string(),
			}),
		),
		totalReturned: j.number(),
	}),
	execute: async ({ limit }, { notion }) => {
		const dataSourceId = requireEnv("SLACK_MESSAGES_DATA_SOURCE_ID");
		const max = Math.min(limit ?? 200, 200);

		const messages: Array<{
			id: string;
			properties: Array<{ name: string; value: string }>;
			bodyMarkdown: string;
		}> = [];
		let cursor: string | undefined;

		while (messages.length < max) {
			const response = await notion.dataSources.query({
				data_source_id: dataSourceId,
				page_size: Math.min(100, max - messages.length),
				start_cursor: cursor,
			});

			for (const page of response.results) {
				const id = pageId(page);
				if (!id) continue;
				const properties = pageProperties(page);
				if (!properties) continue;
				const body = await readPageBody(notion, id);

				const flatProps: Array<{ name: string; value: string }> = [];
				for (const [name, prop] of Object.entries(properties)) {
					const value = readPropertyValue(prop);
					if (value === null) continue;
					flatProps.push({ name, value: String(value) });
				}

				messages.push({
					id,
					properties: flatProps,
					bodyMarkdown: body.markdown,
				});

				if (messages.length >= max) break;
			}

			if (!response.has_more || !response.next_cursor) break;
			cursor = response.next_cursor;
		}

		return { messages, totalReturned: messages.length };
	},
});

// ---------- readWiki ------------------------------------------------------

function wikiNotionTargetId(): string {
	return (
		process.env.WIKI_NOTION_DATA_SOURCE_ID ??
		WIKI_NOTION_DATA_SOURCE_ID_DEFAULT
	);
}

worker.tool("readWiki", {
	title: "Read Wiki Pages",
	description:
		"Fetch wiki pages from the company Notion Wiki with full body markdown. Returns the documented intent of the team: PRDs, Feature Specs, ADRs, Product Decision Records, Runbooks, and other Product/Engineering/Operations documentation. Use this to compare documented expectations against observed execution (commits, errors, meetings, messages). The most valuable synthesis output is the gap between what these docs say should happen and what the other sources show actually happening.",
	schema: j.object({
		sinceDays: j
			.number()
			.describe(
				"Look back N days by Last Updated. Defaults to 90, cap 365.",
			)
			.nullable(),
		limit: j
			.number()
			.describe("Max pages to fetch. Defaults to 20, cap 100.")
			.nullable(),
		categories: j
			.array(j.string())
			.describe(
				'Optional categories to filter to. Valid values: "Product", "Engineering", "Marketing", "Sales", "HR", "Operations", "Finance", "Legal". Defaults to all categories. For synthesis work, the most relevant are typically Product, Engineering, and Operations.',
			)
			.nullable(),
	}),
	outputSchema: j.object({
		pages: j.array(
			j.object({
				id: j.string(),
				title: j.string(),
				category: j.string(),
				status: j.string(),
				priority: j.string(),
				tags: j.string(),
				owner: j.string(),
				lastUpdated: j.string(),
				webUrl: j.string(),
				bodyMarkdown: j.string(),
			}),
		),
		totalReturned: j.number(),
	}),
	execute: async ({ sinceDays, limit, categories }, { notion }) => {
		const dataSourceId = wikiNotionTargetId();
		const lookback = Math.min(sinceDays ?? 365, 365);
		const max = Math.min(limit ?? 100, 100);
		const since = new Date(
			Date.now() - lookback * 86_400_000,
		).toISOString();

		const dateFilter = {
			property: "Last Updated",
			date: { on_or_after: since },
		};

		let combinedFilter: unknown = dateFilter;
		if (categories && categories.length > 0) {
			combinedFilter = {
				and: [
					dateFilter,
					{
						or: categories.map((cat) => ({
							property: "Category",
							select: { equals: cat },
						})),
					},
				],
			};
		}

		const pages: Array<{
			id: string;
			title: string;
			category: string;
			status: string;
			priority: string;
			tags: string;
			owner: string;
			lastUpdated: string;
			webUrl: string;
			bodyMarkdown: string;
		}> = [];
		let cursor: string | undefined;

		while (pages.length < max) {
			const response = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: combinedFilter as never,
				sorts: [{ property: "Last Updated", direction: "descending" }],
				page_size: Math.min(100, max - pages.length),
				start_cursor: cursor,
			});

			for (const page of response.results) {
				const id = pageId(page);
				if (!id) continue;
				const properties = pageProperties(page);
				if (!properties) continue;
				const body = await readPageBody(notion, id);

				pages.push({
					id,
					title: stringValue(queryPropertyValue(properties, "Title")),
					category: stringValue(
						queryPropertyValue(properties, "Category"),
					),
					status: stringValue(queryPropertyValue(properties, "Status")),
					priority: stringValue(
						queryPropertyValue(properties, "Priority"),
					),
					tags: stringValue(queryPropertyValue(properties, "Tags")),
					owner: stringValue(queryPropertyValue(properties, "Owner")),
					lastUpdated: stringValue(
						queryPropertyValue(properties, "Last Updated"),
					),
					webUrl: (page as { url?: string }).url ?? "",
					bodyMarkdown: body.markdown,
				});

				if (pages.length >= max) break;
			}

			if (!response.has_more || !response.next_cursor) break;
			cursor = response.next_cursor;
		}

		return { pages, totalReturned: pages.length };
	},
});

function paragraphHeading(
	content: string,
	level: "heading_1" | "heading_2" | "heading_3",
	color?: QuoteColor,
): BlockObjectRequest {
	const colorField = color ? { color } : {};
	if (level === "heading_1") {
		return {
			object: "block",
			type: "heading_1",
			heading_1: {
				rich_text: [{ type: "text", text: { content } }],
				...colorField,
			},
		};
	}
	if (level === "heading_2") {
		return {
			object: "block",
			type: "heading_2",
			heading_2: {
				rich_text: [{ type: "text", text: { content } }],
				...colorField,
			},
		};
	}
	return {
		object: "block",
		type: "heading_3",
		heading_3: {
			rich_text: [{ type: "text", text: { content } }],
			...colorField,
		},
	};
}

function paragraph(content: string): BlockObjectRequest {
	return {
		object: "block",
		type: "paragraph",
		paragraph: {
			rich_text: [{ type: "text", text: { content } }],
		},
	};
}

function bullet(
	content: string,
	children?: BlockObjectRequest[],
): BlockObjectRequest {
	return {
		object: "block",
		type: "bulleted_list_item",
		bulleted_list_item: {
			rich_text: [{ type: "text", text: { content } }],
			...(children && children.length > 0
				? { children: children as never }
				: {}),
		},
	};
}

function callout(content: string, emoji: string): BlockObjectRequest {
	return {
		object: "block",
		type: "callout",
		callout: {
			rich_text: [{ type: "text", text: { content } }],
			icon: { type: "emoji", emoji: emoji as never },
		},
	};
}

function divider(): BlockObjectRequest {
	return { object: "block", type: "divider", divider: {} };
}

// Default page title: "Two Roads — May 17, 2026". A nod to the two paths
// the forecast section projects, with a plain-language date that's easier
// to scan than an ISO timestamp.
function defaultSynthesisTitle(): string {
	const dateStr = new Date().toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	return `Two Roads — ${dateStr}`;
}

// ----------------------------------------------------------------------------
// Forecast section helpers — the heaven/hell projection rendered after themes
// ----------------------------------------------------------------------------

// Gustave Doré illustrations from Dante's Divine Comedy. Public domain,
// hosted on Wikimedia Commons. The agent can override these via the
// mischievousImageUrl / radiantImageUrl fields in the forecast input.
const DEFAULT_MISCHIEVOUS_IMAGE_URL =
	"https://upload.wikimedia.org/wikipedia/commons/0/0a/Gustave_Dor%C3%A9_-_Dante_Alighieri_-_Inferno_-_Plate_65_%28Canto_XXXIV_-_Lucifer%29.jpg";

const DEFAULT_RADIANT_IMAGE_URL =
	"https://upload.wikimedia.org/wikipedia/commons/a/a0/Paradiso_Canto_31.jpg";

type CalloutColor =
	| "default"
	| "gray_background"
	| "brown_background"
	| "orange_background"
	| "yellow_background"
	| "green_background"
	| "blue_background"
	| "purple_background"
	| "pink_background"
	| "red_background";

type QuoteColor =
	| "default"
	| "gray"
	| "brown"
	| "orange"
	| "yellow"
	| "green"
	| "blue"
	| "purple"
	| "pink"
	| "red";

function mermaidDiagram(content: string): BlockObjectRequest {
	return {
		object: "block",
		type: "code",
		code: {
			rich_text: [{ type: "text", text: { content } }],
			language: "mermaid" as never,
		},
	};
}

function quote(content: string, color: QuoteColor = "default"): BlockObjectRequest {
	return {
		object: "block",
		type: "quote",
		quote: {
			rich_text: [{ type: "text", text: { content } }],
			color,
		},
	};
}

function todo(content: string, checked = false): BlockObjectRequest {
	return {
		object: "block",
		type: "to_do",
		to_do: {
			rich_text: [{ type: "text", text: { content } }],
			checked,
		},
	};
}

function externalImage(url: string, caption?: string): BlockObjectRequest {
	return {
		object: "block",
		type: "image",
		image: {
			type: "external",
			external: { url },
			...(caption
				? { caption: [{ type: "text", text: { content: caption } }] }
				: {}),
		},
	};
}

// Image block that references a Notion file upload by ID. Used for the
// bundled heaven.gif and hell.gif assets that we upload at synthesis time.
function uploadedImage(
	fileUploadId: string,
	caption?: string,
): BlockObjectRequest {
	return {
		object: "block",
		type: "image",
		image: {
			type: "file_upload",
			file_upload: { id: fileUploadId },
			...(caption
				? { caption: [{ type: "text", text: { content: caption } }] }
				: {}),
		},
	};
}

// A resolved image reference for the forecast section. Either an external
// URL (user-provided override) or a Notion file_upload_id (we uploaded
// the bundled GIF at synthesis time).
type ForecastImageRef =
	| { kind: "external"; url: string }
	| { kind: "file_upload"; id: string };

type ForecastImages = {
	mischievous: ForecastImageRef;
	radiant: ForecastImageRef;
};

function forecastImageBlock(
	ref: ForecastImageRef,
	caption?: string,
): BlockObjectRequest {
	if (ref.kind === "external") {
		return externalImage(ref.url, caption);
	}
	return uploadedImage(ref.id, caption);
}

// Upload a local GIF asset (heaven.gif / hell.gif) to Notion and return
// the resulting file_upload_id, which can then be referenced in image blocks.
// Uses the SDK's two-step upload flow: create the upload object, then send
// the file bytes as a single-part multipart payload.
async function uploadForecastGif(
	notion: Client,
	filename: string,
): Promise<string> {
	const filePath = path.join(__dirname, "images", filename);
	const data = await readFile(filePath);
	const upload = await notion.fileUploads.create({
		mode: "single_part",
		filename,
		content_type: "image/gif",
	});
	await notion.fileUploads.send({
		file_upload_id: upload.id,
		file: {
			filename,
			// Copy into a fresh ArrayBuffer-backed Uint8Array. fs.readFile
			// returns a Buffer whose underlying buffer may be a shared pool,
			// which doesn't satisfy DOM's strict BlobPart type.
			data: new Blob([Uint8Array.from(data)], { type: "image/gif" }),
		},
	});
	return upload.id;
}

// Resolve a forecast image: if the agent passed an override URL, use it as
// an external image; otherwise upload the bundled default GIF and reference
// it by file_upload_id. Falls back to the Doré URL if the upload fails so
// the page still renders cleanly.
async function resolveForecastImage(
	notion: Client,
	overrideUrl: string | null,
	defaultGifFilename: string,
	fallbackUrl: string,
): Promise<ForecastImageRef> {
	if (overrideUrl) {
		return { kind: "external", url: overrideUrl };
	}
	try {
		const id = await uploadForecastGif(notion, defaultGifFilename);
		return { kind: "file_upload", id };
	} catch (err) {
		console.error(
			`Failed to upload ${defaultGifFilename}, falling back to default URL:`,
			err,
		);
		return { kind: "external", url: fallbackUrl };
	}
}

function coloredCallout(
	content: string,
	emoji: string,
	color: CalloutColor = "default",
): BlockObjectRequest {
	return {
		object: "block",
		type: "callout",
		callout: {
			rich_text: [{ type: "text", text: { content } }],
			icon: { type: "emoji", emoji: emoji as never },
			color,
		},
	};
}

function columnList(columns: BlockObjectRequest[][]): BlockObjectRequest {
	return {
		object: "block",
		type: "column_list",
		column_list: {
			children: columns.map((children) => ({
				object: "block" as const,
				type: "column" as const,
				column: { children },
			})) as never,
		},
	};
}

// Toggleable heading — a section header that collapses its children. Lets
// us land a tight hero above the fold and tuck long-form content behind
// disclosure arrows so the page reads fast and rewards expansion.
function toggleHeading2(
	content: string,
	children: BlockObjectRequest[],
): BlockObjectRequest {
	return {
		object: "block",
		type: "heading_2",
		heading_2: {
			rich_text: [{ type: "text", text: { content } }],
			is_toggleable: true,
			children: children as never,
		},
	};
}

function toggleHeading3(
	content: string,
	children: BlockObjectRequest[],
): BlockObjectRequest {
	return {
		object: "block",
		type: "heading_3",
		heading_3: {
			rich_text: [{ type: "text", text: { content } }],
			is_toggleable: true,
			children: children as never,
		},
	};
}

function splitParagraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

// The full forecast section, top-down. Epigraph, mermaid, side-by-side
// readings, snapshot, to-dos. The heaven/hell is the page.
function forecastTopBlocks(
	forecast: Forecast,
	forecastImages: ForecastImages | null,
): BlockObjectRequest[] {
	const blocks: BlockObjectRequest[] = [];

	// Optional dramatic epigraph — sets the tone above everything else.
	if (forecast.dramaticEpigraph) {
		blocks.push(
			coloredCallout(forecast.dramaticEpigraph, "⚜️", "orange_background"),
		);
	}

	// Visual centerpiece: the forking trajectory rendered as a Mermaid diagram.
	// Four milestones per path, color-coded red (hell) and blue (heaven) via
	// classDef. Flame and cloud emoji reinforce the heaven/hell theme.
	blocks.push(
		mermaidDiagram(
			[
				"graph LR",
				'  S["📍 Right now"]',
				'  S --> F{"🔱 The Fork"}',
				'  F -->|"Without intervention"| H1["🔥 Weeks: friction"]',
				'  H1 --> H2["🔥 Months: drift"]',
				'  H2 --> H3["🔥 Quarter: haunted"]',
				'  H3 --> H4["🌋 Year-end: Inferno"]',
				'  F -->|"With intervention"| A1["☁️ Weeks: clarity"]',
				'  A1 --> A2["☁️ Months: cadence"]',
				'  A2 --> A3["☁️ Quarter: blessed"]',
				'  A3 --> A4["✨ Year-end: Paradiso"]',
				"  classDef hell fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
				"  classDef heaven fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
				"  class H1,H2,H3,H4 hell",
				"  class A1,A2,A3,A4 heaven",
			].join("\n"),
		),
	);

	// Side-by-side readings — possible because we're at top level, not
	// inside a toggle (column_list doesn't nest in heading children).
	const mischievousImage: ForecastImageRef =
		forecastImages?.mischievous ?? {
			kind: "external",
			url: forecast.mischievousImageUrl ?? DEFAULT_MISCHIEVOUS_IMAGE_URL,
		};
	const radiantImage: ForecastImageRef = forecastImages?.radiant ?? {
		kind: "external",
		url: forecast.radiantImageUrl ?? DEFAULT_RADIANT_IMAGE_URL,
	};

	const mischievousColumn: BlockObjectRequest[] = [
		paragraphHeading("If All Goes Poorly", "heading_2", "red"),
		forecastImageBlock(mischievousImage),
		...splitParagraphs(forecast.mischievousReading).map((p) =>
			quote(p, "red"),
		),
	];

	const radiantColumn: BlockObjectRequest[] = [
		paragraphHeading("If All Goes Amazingly", "heading_2", "blue"),
		forecastImageBlock(radiantImage),
		...splitParagraphs(forecast.radiantReading).map((p) => quote(p, "blue")),
	];

	blocks.push(columnList([mischievousColumn, radiantColumn]));

	// Snapshot — the shared factual preamble. Compact, contextual.
	blocks.push(coloredCallout(forecast.snapshot, "📍", "yellow_background"));

	// Action heading + to-dos.
	blocks.push(paragraphHeading("🔱 What to do right now", "heading_3"));
	for (const item of forecast.fork) {
		blocks.push(todo(`${item.action} — ${item.owner}, ${item.timing}`));
	}

	return blocks;
}

async function fetchGranolaNote(
	noteId: string,
	token: string,
	includeTranscript: boolean,
): Promise<GranolaNote> {
	const url = new URL(
		`https://public-api.granola.ai/v1/notes/${encodeURIComponent(noteId)}`,
	);
	if (includeTranscript) {
		url.searchParams.set("include", "transcript");
	}

	return fetchJson<GranolaNote>(
		url,
		{
			headers: {
				Authorization: `Bearer ${token}`,
			},
		},
		`Granola note ${noteId}`,
	);
}

type GranolaNotionSchema = {
	titleProperty: string;
};

function granolaNotionTargetId(): string {
	return (
		process.env.GRANOLA_NOTION_DATA_SOURCE_ID ??
		process.env.GRANOLA_NOTION_DATABASE_ID ??
		GRANOLA_NOTION_DATA_SOURCE_ID_DEFAULT
	);
}

async function ensureGranolaNotionSchema(
	notion: NotionClientLike,
	dataSourceId: string,
): Promise<GranolaNotionSchema> {
	const dataSource = await notion.dataSources.retrieve({
		data_source_id: dataSourceId,
	});
	const properties = objectValue(objectValue(dataSource)?.properties) ?? {};
	const titleProperty =
		Object.entries(properties).find(
			([, property]) => objectValue(property)?.type === "title",
		)?.[0] ?? "Note";
	const missingProperties: Record<string, unknown> = {};

	for (const [name, config] of Object.entries({
		"Granola Note ID": { rich_text: {} },
		Owner: { rich_text: {} },
		Attendees: { rich_text: {} },
		"Meeting Time": { date: {} },
		Summary: { rich_text: {} },
		"Action Items": { rich_text: {} },
		"Updated Time": { date: {} },
		"Web URL": { url: {} },
	})) {
		if (!properties[name]) {
			missingProperties[name] = config;
		}
	}

	if (Object.keys(missingProperties).length > 0) {
		await notion.dataSources.update({
			data_source_id: dataSourceId,
			properties: missingProperties,
		});
	}

	return { titleProperty };
}

async function upsertGranolaNotePages(
	notion: NotionClientLike,
	dataSourceId: string,
	notes: GranolaNote[],
	schema: GranolaNotionSchema,
): Promise<void> {
	for (const note of notes) {
		await upsertGranolaNotePage(notion, dataSourceId, note, schema);
	}
}

async function upsertGranolaNotePage(
	notion: NotionClientLike,
	dataSourceId: string,
	note: GranolaNote,
	schema: GranolaNotionSchema,
): Promise<void> {
	const { properties, markdown } = toNotionGranolaPage(note, schema);
	const existing = await notion.dataSources.query({
		data_source_id: dataSourceId,
		page_size: 1,
		result_type: "page",
		filter: {
			property: "Granola Note ID",
			rich_text: {
				equals: note.id,
			},
		},
	});
	const page = existing.results.find((result) => result.object === "page");

	if (page) {
		await notion.pages.update({
			page_id: page.id,
			properties,
		});
		await notion.pages.updateMarkdown({
			page_id: page.id,
			type: "replace_content",
			replace_content: {
				new_str: markdown,
				allow_deleting_content: true,
			},
		});
		return;
	}

	await notion.pages.create({
		parent: {
			type: "data_source_id",
			data_source_id: dataSourceId,
		},
		properties,
		markdown,
	});
}

function toNotionGranolaPage(
	note: GranolaNote,
	schema: GranolaNotionSchema,
): { properties: Record<string, unknown>; markdown: string } {
	const summary = note.summary_markdown ?? note.summary_text ?? "";
	const actionItems = extractActionItems(summary);
	const attendees = formatPeople(note.attendees ?? note.calendar_event?.invitees);
	const meetingTime =
		note.calendar_event?.scheduled_start_time ?? note.created_at;

	return {
		properties: {
			[schema.titleProperty]: notionTitle(
				note.title ?? `Granola note ${note.id}`,
			),
			"Granola Note ID": notionRichText(note.id),
			Owner: notionRichText(formatPerson(note.owner)),
			Attendees: notionRichText(attendees),
			"Meeting Time": notionDate(meetingTime),
			Summary: notionRichText(summary),
			"Action Items": notionRichText(actionItems),
			"Updated Time": notionDate(note.updated_at),
			"Web URL": notionUrl(note.web_url ?? undefined),
		},
		markdown: granolaNoteMarkdown(note, actionItems),
	};
}

function granolaNoteChange(note: GranolaNote) {
	const summary = note.summary_markdown ?? note.summary_text ?? "";
	const actionItems = extractActionItems(summary);
	const attendees = formatPeople(note.attendees ?? note.calendar_event?.invitees);
	const meetingTime =
		note.calendar_event?.scheduled_start_time ?? note.created_at;

	return {
		type: "upsert" as const,
		key: note.id,
		properties: {
			Note: Builder.title(note.title ?? `Granola note ${note.id}`),
			"Granola Note ID": Builder.richText(note.id),
			Owner: Builder.richText(formatPerson(note.owner)),
			Attendees: Builder.richText(attendees),
			"Meeting Time": dateTimeOrEmpty(meetingTime),
			Summary: Builder.richText(summary),
			"Action Items": Builder.richText(actionItems),
			"Updated Time": dateTimeOrEmpty(note.updated_at),
			"Web URL": urlOrEmpty(note.web_url),
		},
		upstreamUpdatedAt: note.updated_at,
		pageContentMarkdown: granolaNoteMarkdown(note, actionItems),
	};
}

async function fetchJson<T>(
	url: string | URL,
	init: RequestInit,
	label: string,
): Promise<T> {
	const response = await fetch(url, init);
	await assertOk(response, label);
	return response.json() as Promise<T>;
}

async function fetchJsonWithPagination<T>(
	url: string | URL,
	init: RequestInit,
	label: string,
): Promise<{ body: T; nextCursor?: string }> {
	const response = await fetch(url, init);
	await assertOk(response, label);
	return {
		body: (await response.json()) as T,
		nextCursor: parseSentryNextCursor(response.headers.get("link")),
	};
}

async function assertOk(response: Response, label: string): Promise<void> {
	if (response.status === 429) {
		const retryAfter = Number(response.headers.get("retry-after"));
		throw new RateLimitError({
			retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
		});
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`${label} request failed with ${response.status}: ${body.slice(0, 500)}`,
		);
	}
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`${name} is required. Set it locally in .env or remotely with ntn workers env set ${name}=...`,
		);
	}
	return value;
}

function readIntegerEnv(
	name: string,
	defaultValue: number,
	minimum: number,
	maximum: number,
): number {
	const parsed = Number(process.env[name]);
	if (!Number.isFinite(parsed)) {
		return defaultValue;
	}

	return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function requireAnyEnv(primaryName: string, fallbackName: string): string {
	const value = process.env[primaryName] ?? process.env[fallbackName];
	if (!value) {
		throw new Error(
			`${primaryName} or ${fallbackName} is required. Set it locally in .env or remotely with ntn workers env set ${primaryName}=...`,
		);
	}
	return value;
}

function normalizeNotionId(idOrUrl: string): string {
	const withoutCollection = idOrUrl.replace(/^collection:\/\//, "");
	const compactIdMatch = /([0-9a-f]{32})/i.exec(
		withoutCollection.replace(/-/g, ""),
	);
	if (!compactIdMatch) {
		return withoutCollection;
	}

	return compactIdMatch[1];
}

function parseCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function dateTimeOrEmpty(value: string | undefined | null): TextValue {
	if (!value) {
		return [];
	}

	try {
		return Builder.dateTime(value);
	} catch {
		return [];
	}
}

function bufferedGithubDeltaCursor(now: Date): string {
	return new Date(now.getTime() - GITHUB_DELTA_BUFFER_MS).toISOString();
}

function nextGithubDeltaCursor(
	previousUpdatedSince: string,
	cycleMaxUpdatedAt: string | undefined,
): string {
	const bufferedCursor = bufferedGithubDeltaCursor(new Date());
	const nextObservedCursor = cycleMaxUpdatedAt
		? minIsoDate(cycleMaxUpdatedAt, bufferedCursor)
		: bufferedCursor;

	return maxIsoDate(previousUpdatedSince, nextObservedCursor) ?? bufferedCursor;
}

function bufferedGranolaDeltaCursor(now: Date): string {
	return new Date(now.getTime() - GRANOLA_DELTA_BUFFER_MS).toISOString();
}

function nextGranolaDeltaCursor(
	previousUpdatedAfter: string,
	cycleMaxUpdatedAt: string | undefined,
): string {
	const bufferedCursor = bufferedGranolaDeltaCursor(new Date());
	const nextObservedCursor = cycleMaxUpdatedAt
		? minIsoDate(cycleMaxUpdatedAt, bufferedCursor)
		: bufferedCursor;

	return maxIsoDate(previousUpdatedAfter, nextObservedCursor) ?? bufferedCursor;
}

function maxIsoDate(
	...values: Array<string | undefined | null>
): string | undefined {
	const timestamps = values
		.map((value) => (value ? Date.parse(value) : NaN))
		.filter(Number.isFinite);
	if (timestamps.length === 0) {
		return undefined;
	}

	return new Date(Math.max(...timestamps)).toISOString();
}

function minIsoDate(first: string, second: string): string {
	return Date.parse(first) <= Date.parse(second) ? first : second;
}

function urlOrEmpty(value: string | undefined | null): TextValue {
	return value ? Builder.url(value) : [];
}

function toNumber(value: string | number | undefined): number {
	if (typeof value === "number") {
		return value;
	}

	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toBoundedJson(value: unknown, maxLength = 1800): string {
	const json = JSON.stringify(value, null, 2) ?? "";
	if (json.length <= maxLength) {
		return json;
	}

	return `${json.slice(0, maxLength - 20)}\n... truncated`;
}

function formatActor(actor: GitHubEvent["actor"]): string {
	return actor?.display_login ?? actor?.login ?? "";
}

function formatGithubActivityTitle(event: GitHubEvent): string {
	const actor = formatActor(event.actor);
	return [actor, event.type].filter(Boolean).join(" - ") || event.id;
}

function formatGitRef(payload: JsonRecord | undefined): string {
	const ref = stringValue(payload?.ref);
	if (!ref) {
		return "";
	}

	return ref.replace(/^refs\/heads\//, "");
}

function formatGithubPayload(event: GitHubEvent): string {
	const payload = event.payload;
	if (!payload) {
		return event.type;
	}

	const action = stringValue(payload.action);
	const issue = objectValue(payload.issue);
	const pullRequest = objectValue(payload.pull_request);
	const release = objectValue(payload.release);
	const commits = arrayValue(payload.commits);
	const ref = stringValue(payload.ref);

	if (pullRequest) {
		return compact([
			action,
			`PR #${stringValue(pullRequest.number)}`,
			stringValue(pullRequest.title),
		]).join(" - ");
	}

	if (issue) {
		return compact([
			action,
			`Issue #${stringValue(issue.number)}`,
			stringValue(issue.title),
		]).join(" - ");
	}

	if (release) {
		return compact([action, stringValue(release.name), stringValue(release.tag_name)])
			.join(" - ");
	}

	if (commits.length > 0) {
		return `${commits.length} commit${commits.length === 1 ? "" : "s"} pushed to ${ref}`;
	}

	return compact([action, ref, event.type]).join(" - ");
}

function getGithubEventUrl(
	event: GitHubEvent,
	owner: string,
	repo: string,
): string {
	const payload = event.payload;
	const issueUrl = stringValue(objectValue(payload?.issue)?.html_url);
	const pullRequestUrl = stringValue(objectValue(payload?.pull_request)?.html_url);
	const releaseUrl = stringValue(objectValue(payload?.release)?.html_url);
	const firstCommit = objectValue(arrayValue(payload?.commits)[0]);
	const commitSha = stringValue(firstCommit?.sha);

	return (
		pullRequestUrl ||
		issueUrl ||
		releaseUrl ||
		(commitSha
			? `https://github.com/${owner}/${repo}/commit/${commitSha}`
			: `https://github.com/${owner}/${repo}`)
	);
}

function githubEventMarkdown(
	event: GitHubEvent,
	owner: string,
	repo: string,
): string {
	return [
		`# ${formatGithubActivityTitle(event)}`,
		"",
		`- Type: ${event.type}`,
		`- Actor: ${formatActor(event.actor) || "Unknown"}`,
		`- Repo: ${event.repo?.name ?? `${owner}/${repo}`}`,
		`- Created: ${event.created_at ?? "Unknown"}`,
		`- Source: ${getGithubEventUrl(event, owner, repo)}`,
		"",
		"## Payload Summary",
		"",
		formatGithubPayload(event),
		"",
		"## Raw Payload",
		"",
		"```json",
		toBoundedJson(event.payload ?? {}),
		"```",
	].join("\n");
}

function sentryIssueMarkdown(issue: EnrichedSentryIssue): string {
	const debug = issue.debug;
	return [
		`# ${issue.title ?? `Sentry issue ${issue.id}`}`,
		"",
		"## Overview",
		"",
		`- Status: ${issue.status ?? "Unknown"}`,
		`- Level: ${issue.level ?? "Unknown"}`,
		`- Project: ${issue.project?.slug ?? issue.project?.name ?? "Unknown"}`,
		`- Environment: ${debug?.environment ?? "Unknown"}`,
		`- Release: ${debug?.release ?? "Unknown"}`,
		`- Transaction: ${debug?.transaction ?? "Unknown"}`,
		`- Users: ${toNumber(issue.userCount)}`,
		`- Events: ${toNumber(issue.count)}`,
		`- First seen: ${issue.firstSeen ?? "Unknown"}`,
		`- Last seen: ${issue.lastSeen ?? "Unknown"}`,
		`- Latest event: ${debug?.latestEventId ?? "Unknown"}`,
		`- Source: ${issue.permalink ?? "Unavailable"}`,
		"",
		"## Failure Context",
		"",
		`- Culprit: ${issue.culprit ?? "Unavailable"}`,
		`- Location: ${debug?.location ?? "Unavailable"}`,
		`- Top stack frame: ${debug?.topStackFrame ?? "Unavailable"}`,
		"",
		sentryExceptionSummaryFromDebug(debug) || "No exception summary available.",
		"",
		"## Runtime Context",
		"",
		`- Platform: ${debug?.platform ?? "Unknown"}`,
		`- Browser: ${debug?.browser ?? "Unknown"}`,
		`- OS: ${debug?.os ?? "Unknown"}`,
		`- Runtime: ${debug?.runtime ?? "Unknown"}`,
		`- User: ${debug?.user ?? "Unknown"}`,
		"",
		"## Tags",
		"",
		debug?.tags || "No tags available.",
		"",
		"## Context Summary",
		"",
		debug?.contextSummary || "No context summary available.",
		"",
		"## Raw Context Excerpt",
		"",
		"```json",
		toBoundedJson(debug?.rawContext ?? {}, 4000),
		"```",
	].join("\n");
}

function sentryExceptionSummaryFromDebug(
	debug: SentryDebugContext | undefined,
): string {
	return stringValue(objectValue(debug?.rawContext)?.exception);
}

function granolaNoteMarkdown(note: GranolaNote, actionItems: string): string {
	const summary = note.summary_markdown ?? note.summary_text ?? "";
	const lines = [
		`# ${note.title ?? `Granola note ${note.id}`}`,
		"",
		`- Owner: ${formatPerson(note.owner) || "Unknown"}`,
		`- Attendees: ${formatPeople(note.attendees) || "Unknown"}`,
		`- Meeting time: ${note.calendar_event?.scheduled_start_time ?? note.created_at}`,
		`- Updated: ${note.updated_at}`,
		`- Source: ${note.web_url ?? "Unavailable"}`,
		"",
		"## Action Items",
		"",
		actionItems || "No action items detected.",
		"",
		"## Summary",
		"",
		summary || "No summary available.",
	];

	if (process.env.GRANOLA_INCLUDE_TRANSCRIPT === "true" && note.transcript) {
		lines.push("", "## Transcript", "", toBoundedJson(note.transcript, 12000));
	}

	return lines.join("\n");
}

function extractActionItems(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const actionLines: string[] = [];
	let inActionSection = false;

	for (const line of lines) {
		const normalized = line.trim().toLowerCase();
		const isHeading = /^#{1,6}\s+/.test(line.trim());
		const isActionHeading =
			isHeading &&
			/(action items?|next steps?|follow-?ups?|todos?|to dos?)/i.test(line);

		if (isActionHeading) {
			inActionSection = true;
			continue;
		}

		if (inActionSection && isHeading) {
			inActionSection = false;
		}

		if (inActionSection && line.trim()) {
			actionLines.push(line.trim());
			continue;
		}

		if (
			/^[-*]\s+(todo|to do|follow up|follow-up|action|next step)[:\-]/i.test(
				line.trim(),
			)
		) {
			actionLines.push(line.trim());
		}

		if (normalized.startsWith("action:") || normalized.startsWith("todo:")) {
			actionLines.push(line.trim());
		}
	}

	return actionLines.join("\n").slice(0, 1800);
}

function formatPerson(person: Person | undefined): string {
	if (!person) {
		return "";
	}

	return compact([person.name ?? "", person.email ?? ""]).join(" <") + (
		person.name && person.email ? ">" : ""
	);
}

function formatPeople(people: Person[] | undefined): string {
	return (people ?? []).map(formatPerson).filter(Boolean).join(", ");
}

function parseSentryNextCursor(linkHeader: string | null): string | undefined {
	if (!linkHeader) {
		return undefined;
	}

	for (const part of linkHeader.split(",")) {
		const isNext = /rel="next"/.test(part);
		const hasResults = /results="true"/.test(part);
		const cursor = /cursor="([^"]+)"/.exec(part)?.[1];
		if (isNext && hasResults && cursor) {
			return cursor;
		}
	}

	return undefined;
}

function hasNextRel(linkHeader: string | null): boolean {
	return Boolean(linkHeader?.split(",").some((part) => /rel="next"/.test(part)));
}

function compact(values: Array<string | undefined | null>): string[] {
	return values.filter((value): value is string => Boolean(value));
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const string = stringValue(value);
		if (string) {
			return string;
		}
	}

	return undefined;
}

function firstNumberOrString(
	...values: unknown[]
): string | number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}

		const string = stringValue(value);
		if (string) {
			return string;
		}
	}

	return undefined;
}

function stringValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	return "";
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function objectValue(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
