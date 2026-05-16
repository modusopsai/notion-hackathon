import crypto from "node:crypto";
import {
	Worker,
	RateLimitError,
	WebhookVerificationError,
} from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import type { TextValue } from "@notionhq/workers/types";

const worker = new Worker();
export default worker;

const GITHUB_OWNER_DEFAULT = "modusopsai";
const GITHUB_REPO_DEFAULT = "notion-hackathon";
const GITHUB_EVENTS_PAGE_SIZE = 100;
const GITHUB_ISSUES_PAGE_SIZE = 100;
const GITHUB_DELTA_BUFFER_MS = 60_000;
const GRANOLA_PAGE_SIZE = 30;
const GRANOLA_DELTA_BUFFER_MS = 60_000;
const GRANOLA_NOTION_DATA_SOURCE_ID_DEFAULT =
	"3623edae-28d3-8095-958c-000b712611af";

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
			await upsertSentryIssuePage(notionClient, auth, dataSourceId, issue);
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

	await githubApi.wait();
	const response = await fetch(url, {
		headers: githubHeaders(token),
	});
	await assertOk(response, "GitHub issues and pull requests");

	return {
		issues: (await response.json()) as GitHubIssue[],
		hasMore: hasNextRel(response.headers.get("link")),
	};
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
		pageContentMarkdown: githubIssueMarkdown(issue, repoFullName, type, url),
	};
}

function formatGithubLabels(labels: GitHubIssue["labels"]): string {
	return (labels ?? [])
		.map((label) => (typeof label === "string" ? label : label.name))
		.filter(Boolean)
		.join(", ");
}

function githubIssueMarkdown(
	issue: GitHubIssue,
	repoFullName: string,
	type: string,
	url: string | undefined,
): string {
	return [
		`# ${issue.title ?? `${type} #${issue.number}`}`,
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
		`- Source: ${url ?? "Unavailable"}`,
	].join("\n");
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

			await upsertSentryIssuePage(notionClient, auth, dataSourceId, issue);
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

async function upsertSentryIssuePage(
	notion: NotionClientLike,
	auth: string,
	dataSourceId: string,
	issue: NormalizedSentryIssue,
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

function toNotionSentryProperties(issue: NormalizedSentryIssue) {
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

function sentryIssueMarkdown(issue: SentryIssue): string {
	return [
		`# ${issue.title ?? `Sentry issue ${issue.id}`}`,
		"",
		`- Status: ${issue.status ?? "Unknown"}`,
		`- Level: ${issue.level ?? "Unknown"}`,
		`- Project: ${issue.project?.slug ?? issue.project?.name ?? "Unknown"}`,
		`- Users: ${toNumber(issue.userCount)}`,
		`- Events: ${toNumber(issue.count)}`,
		`- First seen: ${issue.firstSeen ?? "Unknown"}`,
		`- Last seen: ${issue.lastSeen ?? "Unknown"}`,
		`- Source: ${issue.permalink ?? "Unavailable"}`,
		"",
		"## Culprit",
		"",
		issue.culprit ?? "Unavailable",
	].join("\n");
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

function objectValue(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
