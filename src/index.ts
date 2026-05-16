import { Worker, RateLimitError } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import type { TextValue } from "@notionhq/workers/types";

const worker = new Worker();
export default worker;

const GITHUB_OWNER_DEFAULT = "modusopsai";
const GITHUB_REPO_DEFAULT = "notion-hackathon";
const GITHUB_EVENTS_PAGE_SIZE = 100;
const GRANOLA_PAGE_SIZE = 30;

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

type GithubSyncState = {
	seenEventIds?: string[];
};

type SentrySyncState = {
	cursor?: string;
};

type GranolaSyncState = {
	cursor?: string;
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

worker.sync("sentryIssuesSync", {
	database: sentryIssues,
	mode: "replace",
	schedule: "30m",
	execute: async (state: SentrySyncState | undefined) => {
		const token = requireEnv("SENTRY_AUTH_TOKEN");
		const orgSlug = requireEnv("SENTRY_ORG_SLUG");
		const allowedProjects = parseCsv(process.env.SENTRY_PROJECT_SLUGS);
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

		return {
			changes: filteredIssues.map((issue) => ({
				type: "upsert" as const,
				key: issue.id,
				properties: {
					Issue: Builder.title(issue.title ?? `Sentry issue ${issue.id}`),
					"Sentry Issue ID": Builder.richText(issue.id),
					Culprit: Builder.richText(issue.culprit ?? ""),
					Level: Builder.richText(issue.level ?? ""),
					Status: Builder.richText(issue.status ?? ""),
					Project: Builder.richText(
						issue.project?.slug ?? issue.project?.name ?? "",
					),
					"User Count": Builder.number(toNumber(issue.userCount)),
					"Event Count": Builder.number(toNumber(issue.count)),
					"First Seen": dateTimeOrEmpty(issue.firstSeen),
					"Last Seen": dateTimeOrEmpty(issue.lastSeen),
					Permalink: urlOrEmpty(issue.permalink),
				},
				upstreamUpdatedAt: issue.lastSeen,
				pageContentMarkdown: sentryIssueMarkdown(issue),
			})),
			hasMore: nextCursor !== undefined,
			nextState: nextCursor ? { cursor: nextCursor } : undefined,
		};
	},
});

worker.sync("granolaNotesSync", {
	database: granolaNotes,
	mode: "replace",
	schedule: "1h",
	execute: async (state: GranolaSyncState | undefined) => {
		const token = requireEnv("GRANOLA_API_KEY");
		const includeTranscript = process.env.GRANOLA_INCLUDE_TRANSCRIPT === "true";
		const listUrl = new URL("https://public-api.granola.ai/v1/notes");
		listUrl.searchParams.set("page_size", String(GRANOLA_PAGE_SIZE));
		if (state?.cursor) {
			listUrl.searchParams.set("cursor", state.cursor);
		}

		await granolaApi.wait();
		const page = await fetchJson<{
			notes: GranolaListNote[];
			hasMore: boolean;
			cursor: string | null;
		}>(
			listUrl,
			{
				headers: {
					Authorization: `Bearer ${token}`,
				},
			},
			"Granola notes list",
		);

		const notes = await Promise.all(
			page.notes.map(async (note) => {
				await granolaApi.wait();
				return fetchGranolaNote(note.id, token, includeTranscript);
			}),
		);

		return {
			changes: notes.map((note) => {
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
			}),
			hasMore: page.hasMore,
			nextState:
				page.hasMore && page.cursor ? { cursor: page.cursor } : undefined,
		};
	},
});

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

function compact(values: Array<string | undefined | null>): string[] {
	return values.filter((value): value is string => Boolean(value));
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
