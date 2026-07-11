import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// Extend the generated Env interface with secrets declared via `wrangler secret`
interface WorkerEnv extends Env {
	API_KEY: string;
	ATHLETE_ID: string;
}

const INTERVALS_API_BASE = "https://intervals.icu/api/v1";

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

type ApiResult = Record<string, unknown> | unknown[];

async function makeIntervalsRequest(
	apiKey: string,
	path: string,
	params?: Record<string, string | number>,
	method = "GET",
	body?: Record<string, unknown>,
): Promise<ApiResult> {
	const url = new URL(`${INTERVALS_API_BASE}${path}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, String(v));
		}
	}

	const headers: Record<string, string> = {
		Authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`,
		Accept: "application/json",
		"User-Agent": "intervals-mcp-ts/1.0",
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";

	const res = await fetch(url.toString(), {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		return { error: true, status: res.status, message: text };
	}

	const text = await res.text();
	if (!text) return {};
	try {
		return JSON.parse(text) as ApiResult;
	} catch {
		return { error: true, message: "Invalid JSON in response" };
	}
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number): string {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d.toISOString().slice(0, 10);
}

function resolveDateParams(
	startDate: string | undefined,
	endDate: string | undefined,
): [string, string] {
	return [startDate || daysAgoStr(30), endDate || todayStr()];
}

// ---------------------------------------------------------------------------
// Formatting helpers (ported from Python utils/formatting.py)
// ---------------------------------------------------------------------------

type Activity = Record<string, unknown>;

function getActivityValue(activity: Activity, ...keys: string[]): unknown {
	for (const key of keys) {
		const val = activity[key];
		if (val !== null && val !== undefined) return val;
	}
	return undefined;
}

function addField(lines: string[], label: string, value: unknown, unit = ""): void {
	if (value === null || value === undefined) return;
	const suffix = unit ? ` ${unit}` : "";
	lines.push(`  ${label}: ${value}${suffix}`);
}

function addSection(lines: string[], heading: string, sectionLines: string[]): void {
	if (sectionLines.length > 0) {
		lines.push(heading);
		lines.push(...sectionLines);
	}
}

function buildIgnoreFlagLines(activity: Activity, prefix = "  "): string[] {
	const lines: string[] = [];
	if (activity["icu_ignore_time"]) lines.push(`${prefix}Ignore Time: True`);
	if (activity["icu_ignore_power"]) lines.push(`${prefix}Ignore Power: True`);
	if (activity["icu_ignore_hr"]) lines.push(`${prefix}Ignore HR: True`);
	return lines;
}

function normaliseStartTime(raw: unknown): string {
	if (typeof raw !== "string") return String(raw ?? "Unknown");
	if (raw.length > 10) {
		try {
			const dt = new Date(raw);
			if (!isNaN(dt.getTime())) {
				return dt.toISOString().replace("T", " ").slice(0, 19);
			}
		} catch {
			// fall through
		}
	}
	return raw;
}

function formatActivitySummary(activity: Activity): string {
	const rawStart = activity["startTime"] ?? activity["start_date"];
	const startTime = normaliseStartTime(rawStart);

	let rpe: unknown = activity["perceived_exertion"] ?? activity["icu_rpe"];
	if (typeof rpe === "number") rpe = `${rpe}/10`;

	let feel: unknown = activity["feel"];
	if (typeof feel === "number") feel = `${feel}/5`;

	const lines: string[] = [
		`Activity: ${activity["name"] ?? "Unnamed"}`,
		`  ID: ${activity["id"] ?? "N/A"}`,
		`  Type: ${activity["type"] ?? "Unknown"}`,
		`  Date: ${startTime}`,
	];
	if (activity["description"]) lines.push(`  Description: ${activity["description"]}`);

	const distance = activity["distance"];
	const duration = activity["duration"] ?? activity["elapsed_time"];
	const movingTime = activity["moving_time"];
	if (distance) lines.push(`  Distance: ${distance} m`);
	if (duration) lines.push(`  Duration: ${duration}s`);
	if (movingTime !== undefined && movingTime !== duration) lines.push(`  Moving Time: ${movingTime}s`);
	const elevGain = getActivityValue(activity, "elevationGain", "total_elevation_gain");
	if (elevGain) lines.push(`  Elevation Gain: ${elevGain} m`);

	const powerLines: string[] = [];
	addField(powerLines, "Avg Power", getActivityValue(activity, "avgPower", "icu_average_watts", "average_watts"), "W");
	addField(powerLines, "Weighted Avg", activity["icu_weighted_avg_watts"], "W");
	addField(powerLines, "Training Load", getActivityValue(activity, "trainingLoad", "icu_training_load"));
	addField(powerLines, "FTP", activity["icu_ftp"], "W");
	addField(powerLines, "Intensity", activity["icu_intensity"]);
	addField(powerLines, "Variability Index", activity["icu_variability_index"]);
	addField(powerLines, "Power:HR", activity["icu_power_hr"]);
	addSection(lines, "  Power:", powerLines);

	const hrLines: string[] = [];
	addField(hrLines, "Avg HR", getActivityValue(activity, "avgHr", "average_heartrate"), "bpm");
	addField(hrLines, "Max HR", activity["max_heartrate"], "bpm");
	addField(hrLines, "LTHR", activity["lthr"], "bpm");
	addField(hrLines, "Resting HR", activity["icu_resting_hr"], "bpm");
	addField(hrLines, "Decoupling", activity["decoupling"]);
	addSection(lines, "  HR:", hrLines);

	const otherLines: string[] = [];
	addField(otherLines, "Cadence", activity["average_cadence"], "rpm");
	addField(otherLines, "Calories", activity["calories"]);
	addField(otherLines, "Avg Speed", activity["average_speed"], "m/s");
	addField(otherLines, "Avg Stride", activity["average_stride"]);
	addField(otherLines, "L/R Balance", activity["avg_lr_balance"]);
	addField(otherLines, "Weight", activity["icu_weight"], "kg");
	addField(otherLines, "RPE", rpe);
	addField(otherLines, "Feel", feel);
	addSection(lines, "  Metrics:", otherLines);

	const envLines: string[] = [];
	addField(envLines, "Trainer", activity["trainer"]);
	addField(envLines, "Avg Temp", activity["average_temp"], "°C");
	addField(envLines, "Wind", activity["average_wind_speed"], "km/h");
	addSection(lines, "  Environment:", envLines);

	const loadLines: string[] = [];
	addField(loadLines, "CTL", activity["icu_ctl"]);
	addField(loadLines, "ATL", activity["icu_atl"]);
	addField(loadLines, "TRIMP", activity["trimp"]);
	addField(loadLines, "Polarization", activity["polarization_index"]);
	addField(loadLines, "Power Load", activity["power_load"]);
	addField(loadLines, "HR Load", activity["hr_load"]);
	addField(loadLines, "Pace Load", activity["pace_load"]);
	addField(loadLines, "EF", activity["icu_efficiency_factor"]);
	addSection(lines, "  Load:", loadLines);

	const complianceLines: string[] = [];
	addField(complianceLines, "Paired Event ID", activity["paired_event_id"]);
	const compliance = activity["compliance"];
	if (compliance !== null && compliance !== undefined) {
		addField(complianceLines, "Compliance", `${(compliance as number).toFixed(2)}%`);
	}
	addSection(lines, "  Workout Compliance:", complianceLines);

	addSection(lines, "  Data Flags:", buildIgnoreFlagLines(activity));

	if (activity["device_name"]) lines.push(`  Device: ${activity["device_name"]}`);

	return lines.join("\n");
}

function formatActivityCompact(activity: Activity): string {
	const rawStart = activity["startTime"] ?? activity["start_date"] ?? "";
	let startTime = typeof rawStart === "string" ? rawStart : String(rawStart);
	if (startTime.length > 10) {
		try {
			const dt = new Date(startTime);
			if (!isNaN(dt.getTime())) startTime = dt.toISOString().slice(0, 10);
		} catch {
			// ignore
		}
	}

	const name = activity["name"] ?? "Unnamed";
	const actType = activity["type"] ?? "?";
	const actId = activity["id"] ?? "";

	const parts = [`${startTime} | ${actType}: ${name} (ID:${actId})`];

	const distance = activity["distance"];
	if (distance !== null && distance !== undefined) parts.push(`${Math.round(distance as number)}m`);

	const duration = (activity["duration"] ?? activity["elapsed_time"]) as number | undefined;
	if (duration !== null && duration !== undefined) {
		const mins = Math.floor(duration / 60);
		parts.push(`${mins}min`);
	}

	const tl = getActivityValue(activity, "trainingLoad", "icu_training_load");
	if (tl !== null && tl !== undefined) parts.push(`TL:${tl}`);

	const avgHr = getActivityValue(activity, "avgHr", "average_heartrate");
	if (avgHr !== null && avgHr !== undefined) parts.push(`HR:${avgHr}`);

	const avgPower = getActivityValue(activity, "avgPower", "icu_average_watts", "average_watts");
	if (avgPower !== null && avgPower !== undefined) parts.push(`Pwr:${avgPower}W`);

	return parts.join(" | ");
}

function formatIgnoreFlags(activity: Activity): string {
	const lines = buildIgnoreFlagLines(activity);
	if (lines.length > 0) return "Data Flags:\n" + lines.join("\n") + "\n\n";
	return "";
}

function formatIntervals(data: Activity): string {
	let result = `Intervals Analysis: ID=${data["id"] ?? "N/A"}\n\n`;

	const icuIntervals = data["icu_intervals"];
	if (Array.isArray(icuIntervals) && icuIntervals.length > 0) {
		for (let i = 0; i < icuIntervals.length; i++) {
			const iv = icuIntervals[i] as Activity;
			const label = iv["label"] ?? `Interval ${i + 1}`;
			const ivType = iv["type"] ?? "Unknown";
			const elapsed = iv["elapsed_time"] ?? 0;
			const dist = iv["distance"];
			let header = `[${i + 1}] ${label} (${ivType}) ${elapsed}s`;
			if (dist) header += ` ${dist}m`;
			result += header + "\n";

			const fields: string[] = [];
			addField(fields, "Avg Pwr", iv["average_watts"], "W");
			addField(fields, "Max Pwr", iv["max_watts"], "W");
			addField(fields, "W. Avg Pwr", iv["weighted_average_watts"], "W");
			addField(fields, "W/kg", iv["average_watts_kg"]);
			addField(fields, "Intensity", iv["intensity"]);
			addField(fields, "TL", iv["training_load"]);
			const zone = iv["zone"];
			if (zone !== null && zone !== undefined) {
				const zMin = iv["zone_min_watts"] ?? "";
				const zMax = iv["zone_max_watts"] ?? "";
				fields.push(`  Zone: ${zone} (${zMin}-${zMax}W)`);
			}
			addField(fields, "Avg HR", iv["average_heartrate"], "bpm");
			addField(fields, "Max HR", iv["max_heartrate"], "bpm");
			addField(fields, "Decoupling", iv["decoupling"]);
			addField(fields, "Avg Speed", iv["average_speed"], "m/s");
			addField(fields, "GAP", iv["gap"], "m/s");
			addField(fields, "Avg Cadence", iv["average_cadence"], "rpm");
			addField(fields, "Stride", iv["average_stride"]);
			addField(fields, "Elev Gain", iv["total_elevation_gain"], "m");
			addField(fields, "Gradient", iv["average_gradient"], "%");
			addField(fields, "Temp", iv["average_temp"], "°C");
			if (fields.length > 0) result += fields.join("\n") + "\n";
			result += "\n";
		}
	}

	const icuGroups = data["icu_groups"];
	if (Array.isArray(icuGroups) && icuGroups.length > 0) {
		result += "Groups:\n";
		for (let i = 0; i < icuGroups.length; i++) {
			const group = icuGroups[i] as Activity;
			const gid = group["id"] ?? `Group ${i + 1}`;
			const count = group["count"] ?? 0;
			const elapsed = group["elapsed_time"] ?? 0;
			const dist = group["distance"];
			let header = `  ${gid} (${count} intervals) ${elapsed}s`;
			if (dist) header += ` ${dist}m`;
			result += header + "\n";

			const fields: string[] = [];
			addField(fields, "Avg Pwr", group["average_watts"], "W");
			addField(fields, "Avg HR", group["average_heartrate"], "bpm");
			addField(fields, "Avg Speed", group["average_speed"], "m/s");
			addField(fields, "Avg Cadence", group["average_cadence"], "rpm");
			if (fields.length > 0) result += fields.join("\n") + "\n";
			result += "\n";
		}
	}

	return result;
}

function formatActivityMessage(message: Activity): string {
	const created = message["created"];
	let createdStr = typeof created === "string" ? created : "Unknown";
	if (typeof created === "string" && created.length > 10) {
		try {
			const dt = new Date(created);
			if (!isNaN(dt.getTime())) createdStr = dt.toISOString().replace("T", " ").slice(0, 19);
		} catch {
			// keep original
		}
	}
	return `Author: ${message["name"] ?? "Unknown"}\nDate: ${createdStr}\nType: ${message["type"] ?? "TEXT"}\nContent: ${message["content"] ?? ""}`;
}

// ---------------------------------------------------------------------------
// Activity parsing & filtering (ported from Python tools/activities.py)
// ---------------------------------------------------------------------------

function parseActivitiesFromResult(result: ApiResult): Activity[] {
	if (Array.isArray(result)) {
		return result.filter((item): item is Activity => typeof item === "object" && item !== null);
	}
	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		for (const value of Object.values(obj)) {
			if (Array.isArray(value)) {
				return value.filter((item): item is Activity => typeof item === "object" && item !== null);
			}
		}
		if ("name" in obj || "startTime" in obj || "distance" in obj) {
			return [obj];
		}
	}
	return [];
}

function filterNamedActivities(activities: Activity[]): Activity[] {
	return activities.filter((a) => a["name"] && a["name"] !== "Unnamed");
}

function filterActivitiesByDate(activities: Activity[], startDate: string, endDate: string): Activity[] {
	let startDt: Date, endDt: Date;
	try {
		startDt = new Date(startDate);
		endDt = new Date(endDate);
	} catch {
		return activities;
	}

	return activities.filter((activity) => {
		const raw =
			(activity["start_date_local"] as string | undefined) ??
			(activity["startTime"] as string | undefined) ??
			(activity["start_date"] as string | undefined) ??
			"";
		if (!raw) return false;
		try {
			const actDate = new Date(String(raw).slice(0, 10));
			return actDate >= startDt && actDate <= endDt;
		} catch {
			return false;
		}
	});
}

function convertActivityDatesToLocal(activities: Activity[], timezone: string): Activity[] {
	for (const activity of activities) {
		for (const field of ["start_date_local", "startTime", "start_date"]) {
			const raw = activity[field];
			if (typeof raw === "string") {
				try {
					const dt = new Date(raw);
					if (!isNaN(dt.getTime())) {
						activity[field] = dt
							.toLocaleString("sv-SE", { timeZone: timezone })
							.replace("T", " ");
					}
				} catch {
					// keep original
				}
			}
		}
	}
	return activities;
}

function formatActivitiesResponse(
	activities: Activity[],
	athleteId: string,
	includeUnnamed: boolean,
	compact: boolean,
): string {
	if (activities.length === 0) {
		if (includeUnnamed) {
			return `No valid activities found for athlete ${athleteId} in the specified date range.`;
		}
		return `No named activities found for athlete ${athleteId} in the specified date range. Try with include_unnamed=true to see all activities.`;
	}

	const formatter = compact ? formatActivityCompact : formatActivitySummary;
	let summary = "Activities:\n\n";
	for (const activity of activities) {
		summary += formatter(activity) + "\n";
	}
	return summary;
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function createServer(env: WorkerEnv): McpServer {
	const server = new McpServer({
		name: "intervals-mcp-ts",
		version: "1.0.0",
	});

	// ------------------------------------------------------------------
	// get_activities
	// ------------------------------------------------------------------
	server.tool(
		"get_activities",
		"Get a list of activities for an athlete from Intervals.icu",
		{
			athlete_id: z
				.string()
				.optional()
				.describe(
					"The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)",
				),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			start_date: z
				.string()
				.optional()
				.describe("Start date in YYYY-MM-DD format (optional, defaults to 30 days ago)"),
			end_date: z
				.string()
				.optional()
				.describe("End date in YYYY-MM-DD format (optional, defaults to today)"),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Maximum number of activities to return (optional, defaults to 10)"),
			include_unnamed: z
				.boolean()
				.optional()
				.describe("Whether to include unnamed activities (optional, defaults to false)"),
			compact: z
				.boolean()
				.optional()
				.describe(
					"If true, return a brief one-line-per-activity summary to save tokens (optional, defaults to true)",
				),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const athleteId = args.athlete_id || env.ATHLETE_ID;
			if (!athleteId) {
				return {
					content: [
						{
							type: "text",
							text: "Error: No athlete ID provided and no default ATHLETE_ID found in environment variables.",
						},
					],
				};
			}

			const limit = args.limit ?? 10;
			const includeUnnamed = args.include_unnamed ?? false;
			const compact = args.compact ?? true;
			const [startDate, endDate] = resolveDateParams(args.start_date, args.end_date);

			// Fetch athlete timezone
			let athleteTimezone = "UTC";
			const athleteResult = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}`);
			if (
				!Array.isArray(athleteResult) &&
				typeof athleteResult["timezone"] === "string"
			) {
				athleteTimezone = athleteResult["timezone"];
			}

			const apiLimit = includeUnnamed ? limit : limit * 3;
			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/activities`, {
				oldest: startDate,
				newest: endDate,
				limit: apiLimit,
			});

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching activities: ${msg}` }] };
			}

			if (!result || (Array.isArray(result) && result.length === 0)) {
				return {
					content: [
						{
							type: "text",
							text: `No activities found for athlete ${athleteId} in the specified date range.`,
						},
					],
				};
			}

			let activities = parseActivitiesFromResult(result);
			activities = convertActivityDatesToLocal(activities, athleteTimezone);

			if (activities.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No valid activities found for athlete ${athleteId} in the specified date range.`,
						},
					],
				};
			}

			activities = filterActivitiesByDate(activities, startDate, endDate);
			if (!includeUnnamed) activities = filterNamedActivities(activities);
			activities = activities.slice(0, limit);

			return {
				content: [
					{
						type: "text",
						text: formatActivitiesResponse(activities, athleteId, includeUnnamed, compact),
					},
				],
			};
		},
	);

	// ------------------------------------------------------------------
	// get_activity_details
	// ------------------------------------------------------------------
	server.tool(
		"get_activity_details",
		"Get detailed information for a specific activity from Intervals.icu",
		{
			activity_id: z.string().describe("The Intervals.icu activity ID"),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const result = await makeIntervalsRequest(apiKey, `/activity/${args.activity_id}`);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return {
					content: [{ type: "text", text: `Error fetching activity details: ${msg}` }],
				};
			}

			if (!result || (Array.isArray(result) && result.length === 0)) {
				return {
					content: [{ type: "text", text: `No details found for activity ${args.activity_id}.` }],
				};
			}

			const activityData: Activity = Array.isArray(result)
				? (result[0] as Activity)
				: (result as Activity);

			if (typeof activityData !== "object" || activityData === null) {
				return {
					content: [
						{ type: "text", text: `Invalid activity format for activity ${args.activity_id}.` },
					],
				};
			}

			let detailedView = formatActivitySummary(activityData);

			const zones = activityData["zones"] as Record<string, unknown[]> | undefined;
			if (zones) {
				detailedView += "\nPower Zones:\n";
				const powerZones = (zones["power"] ?? []) as Array<Record<string, unknown>>;
				for (const zone of powerZones) {
					detailedView += `Zone ${zone["number"]}: ${zone["secondsInZone"]} seconds\n`;
				}

				detailedView += "\nHeart Rate Zones:\n";
				const hrZones = (zones["hr"] ?? []) as Array<Record<string, unknown>>;
				for (const zone of hrZones) {
					detailedView += `Zone ${zone["number"]}: ${zone["secondsInZone"]} seconds\n`;
				}
			}

			return { content: [{ type: "text", text: detailedView }] };
		},
	);

	// ------------------------------------------------------------------
	// get_activity_intervals
	// ------------------------------------------------------------------
	server.tool(
		"get_activity_intervals",
		"Get interval data for a specific activity from Intervals.icu. Returns detailed metrics for each interval including power, heart rate, cadence, speed, and environmental data.",
		{
			activity_id: z.string().describe("The Intervals.icu activity ID"),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const result = await makeIntervalsRequest(apiKey, `/activity/${args.activity_id}/intervals`);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching intervals: ${msg}` }] };
			}

			if (!result || (Array.isArray(result) && result.length === 0)) {
				return {
					content: [{ type: "text", text: `No interval data found for activity ${args.activity_id}.` }],
				};
			}

			if (
				Array.isArray(result) ||
				(!("icu_intervals" in result) && !("icu_groups" in result))
			) {
				return {
					content: [
						{
							type: "text",
							text: `No interval data or unrecognized format for activity ${args.activity_id}.`,
						},
					],
				};
			}

			// Fetch activity details to get ignore flags
			let ignoreFlagsText = "";
			const activityResult = await makeIntervalsRequest(apiKey, `/activity/${args.activity_id}`);
			if (!Array.isArray(activityResult) && !activityResult["error"]) {
				ignoreFlagsText = formatIgnoreFlags(activityResult);
			}

			return {
				content: [{ type: "text", text: ignoreFlagsText + formatIntervals(result as Activity) }],
			};
		},
	);

	// ------------------------------------------------------------------
	// get_activity_histogram
	// ------------------------------------------------------------------
	server.tool(
		"get_activity_histogram",
		"Get histogram data for a specific activity from Intervals.icu. Intended for in-depth analysis of a single activity.",
		{
			activity_id: z.string().describe("The Intervals.icu activity ID"),
			histogram_type: z
				.enum(["power", "hr", "pace"])
				.describe('Type of histogram to retrieve. One of: "power", "hr", "pace"'),
			bucket_size: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Width of each bucket (optional). For power: watts (defaults to 10), for hr: bpm (defaults to 5). Not used for pace.",
				),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const endpointMap: Record<string, string> = {
				power: "power-histogram",
				hr: "hr-histogram",
				pace: "pace-histogram",
			};
			const defaultBucketSizes: Record<string, number> = { power: 10, hr: 5 };

			const url = `/activity/${args.activity_id}/${endpointMap[args.histogram_type]}`;
			const params: Record<string, number> = {};
			if (args.histogram_type !== "pace") {
				params["bucketSize"] = args.bucket_size ?? defaultBucketSizes[args.histogram_type];
			}

			const result = await makeIntervalsRequest(apiKey, url, Object.keys(params).length ? params : undefined);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return {
					content: [
						{ type: "text", text: `Error fetching ${args.histogram_type} histogram: ${msg}` },
					],
				};
			}

			if (!result || (Array.isArray(result) && result.length === 0)) {
				return {
					content: [
						{
							type: "text",
							text: `No ${args.histogram_type} histogram data found for activity ${args.activity_id}.`,
						},
					],
				};
			}

			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		},
	);

	// ------------------------------------------------------------------
	// get_activity_streams
	// ------------------------------------------------------------------
	server.tool(
		"get_activity_streams",
		"Get time-series stream data for a specific activity from Intervals.icu (power, heart rate, cadence, altitude, distance, temperature, velocity).",
		{
			activity_id: z.string().describe("The Intervals.icu activity ID"),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			stream_types: z
				.string()
				.optional()
				.describe(
					"Comma-separated list of stream types to retrieve (optional, defaults to all common types). Available: time, watts, heartrate, cadence, altitude, distance, core_temperature, skin_temperature, velocity_smooth",
				),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const types =
				args.stream_types || "time,watts,heartrate,cadence,altitude,distance,velocity_smooth";

			const result = await makeIntervalsRequest(apiKey, `/activity/${args.activity_id}/streams`, {
				types,
			});

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching activity streams: ${msg}` }] };
			}

			const streams = Array.isArray(result) ? result : [];
			if (streams.length === 0) {
				return {
					content: [{ type: "text", text: `No stream data found for activity ${args.activity_id}.` }],
				};
			}

			let summary = `Activity Streams for ${args.activity_id}:\n\n`;
			for (const stream of streams) {
				if (typeof stream !== "object" || stream === null) continue;
				const s = stream as Activity;
				const streamType = s["type"] ?? "unknown";
				const streamName = s["name"] ?? streamType;
				const data = Array.isArray(s["data"]) ? (s["data"] as unknown[]) : [];
				const valueType = s["valueType"] ?? "";

				summary += `Stream: ${streamName} (${streamType})\n`;
				summary += `  Value Type: ${valueType}\n`;
				summary += `  Data Points: ${data.length}\n`;

				if (data.length > 0) {
					if (data.length <= 10) {
						summary += `  Values: ${JSON.stringify(data)}\n`;
					} else {
						summary += `  First 5 values: ${JSON.stringify(data.slice(0, 5))}\n`;
						summary += `  Last 5 values: ${JSON.stringify(data.slice(-5))}\n`;
					}
				}
				summary += "\n";
			}

			return { content: [{ type: "text", text: summary }] };
		},
	);

	// ------------------------------------------------------------------
	// get_activity_messages
	// ------------------------------------------------------------------
	server.tool(
		"get_activity_messages",
		"Get messages (notes/comments) for a specific activity from Intervals.icu",
		{
			activity_id: z.string().describe("The Intervals.icu activity ID"),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const result = await makeIntervalsRequest(apiKey, `/activity/${args.activity_id}/messages`);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching activity messages: ${msg}` }] };
			}

			const messages = Array.isArray(result) ? result : [];
			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: `No messages found for activity ${args.activity_id}.` }],
				};
			}

			let output = `Messages for activity ${args.activity_id}:\n\n`;
			for (const msg of messages) {
				if (typeof msg === "object" && msg !== null) {
					output += formatActivityMessage(msg as Activity) + "\n\n";
				}
			}

			return { content: [{ type: "text", text: output }] };
		},
	);

	// ------------------------------------------------------------------
	// add_activity_message
	// ------------------------------------------------------------------
	server.tool(
		"add_activity_message",
		"Add a message (note/comment) to an activity on Intervals.icu",
		{
			activity_id: z.string().describe("The Intervals.icu activity ID"),
			content: z.string().describe("The message text to add"),
			api_key: z
				.string()
				.optional()
				.describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const result = await makeIntervalsRequest(
				apiKey,
				`/activity/${args.activity_id}/messages`,
				undefined,
				"POST",
				{ content: args.content },
			);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error adding message to activity: ${msg}` }] };
			}

			if (Array.isArray(result) || typeof result !== "object") {
				return {
					content: [{ type: "text", text: "Error: Unexpected response when adding message." }],
				};
			}

			const msgId = result["id"];
			if (msgId !== null && msgId !== undefined) {
				return {
					content: [
						{
							type: "text",
							text: `Successfully added message (ID: ${msgId}) to activity ${args.activity_id}.`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Message appears to have been added to activity ${args.activity_id}, but no ID was returned. Please verify manually.`,
					},
				],
			};
		},
	);

	return server;
}

// ---------------------------------------------------------------------------
// Cloudflare Worker export
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		const server = createServer(env);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	},
} satisfies ExportedHandler<WorkerEnv>;
