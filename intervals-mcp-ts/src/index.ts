import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// Extend the generated Env interface with secrets declared via `wrangler secret`
interface WorkerEnv extends Env {
	API_KEY: string;
	ATHLETE_ID: string;
	// Shared secret required on every request (see `checkSharedSecret` below).
	// Set with `wrangler secret put MCP_SHARED_SECRET` in production, or add
	// to .dev.vars for local development.
	MCP_SHARED_SECRET: string;
}

const INTERVALS_API_BASE = "https://intervals.icu/api/v1";

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

type ApiResult = Record<string, unknown> | unknown[];

type ParamValue = string | number | boolean | Array<string | number>;

async function makeIntervalsRequest(
	apiKey: string,
	path: string,
	params?: Record<string, ParamValue | undefined>,
	method = "GET",
	body?: Record<string, unknown>,
): Promise<ApiResult> {
	const url = new URL(`${INTERVALS_API_BASE}${path}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined) continue;
			if (Array.isArray(v)) {
				for (const item of v) url.searchParams.append(k, String(item));
			} else {
				url.searchParams.set(k, String(v));
			}
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

function daysAheadStr(n: number): string {
	const d = new Date();
	d.setDate(d.getDate() + n);
	return d.toISOString().slice(0, 10);
}

function isValidDateStr(dateStr: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
	const d = new Date(`${dateStr}T00:00:00Z`);
	return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

function resolveDateParams(startDate: string | undefined, endDate: string | undefined): [string, string] {
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

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function capitalize(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Wellness formatting (ported from Python utils/formatting.py wellness helpers)
// ---------------------------------------------------------------------------

const WELLNESS_FIELDS = new Set(["training", "sport_info", "vital_signs", "sleep", "menstrual", "subjective", "nutrition", "activity"]);

class TrackedEntries {
	accessed = new Set<string>();
	constructor(
		public data: Activity,
		private track: boolean,
	) {}
	get(key: string): unknown {
		if (this.track) this.accessed.add(key);
		return this.data[key];
	}
	has(key: string): boolean {
		if (this.track) this.accessed.add(key);
		return key in this.data;
	}
}

function formatTrainingMetrics(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	for (const [k, label] of [
		["ctl", "Fitness (CTL)"],
		["atl", "Fatigue (ATL)"],
		["rampRate", "Ramp Rate"],
		["ctlLoad", "CTL Load"],
		["atlLoad", "ATL Load"],
	]) {
		const v = entries.get(k);
		if (v !== null && v !== undefined) lines.push(`- ${label}: ${v}`);
	}
	return lines;
}

function formatSportInfo(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	const sportInfo = entries.get("sportInfo");
	if (Array.isArray(sportInfo) && sportInfo.length > 0) {
		for (const sport of sportInfo) {
			if (isRecord(sport) && sport["eftp"] !== null && sport["eftp"] !== undefined) {
				lines.push(`- ${sport["type"]}: eFTP = ${sport["eftp"]}`);
			}
		}
	}
	return lines;
}

function formatVitalSigns(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	const specs: [string, string, string][] = [
		["weight", "Weight", "kg"],
		["restingHR", "Resting HR", "bpm"],
		["hrv", "HRV", ""],
		["hrvSDNN", "HRV SDNN", ""],
		["avgSleepingHR", "Average Sleeping HR", "bpm"],
		["spO2", "SpO2", "%"],
		["systolic", "Systolic BP", ""],
		["diastolic", "Diastolic BP", ""],
		["respiration", "Respiration", "breaths/min"],
		["bloodGlucose", "Blood Glucose", "mmol/L"],
		["lactate", "Lactate", "mmol/L"],
		["vo2max", "VO2 Max", "ml/kg/min"],
		["bodyFat", "Body Fat", "%"],
		["abdomen", "Abdomen", "cm"],
		["baevskySI", "Baevsky Stress Index", ""],
	];
	for (const [k, label, unit] of specs) {
		const v = entries.get(k);
		if (v === null || v === undefined) continue;
		if (k === "systolic") {
			const diastolic = entries.get("diastolic");
			if (diastolic !== null && diastolic !== undefined) {
				lines.push(`- Blood Pressure: ${v}/${diastolic} mmHg`);
			}
		} else if (k !== "diastolic") {
			lines.push(`- ${label}: ${v}${unit ? ` ${unit}` : ""}`);
		}
	}
	return lines;
}

function formatSleepRecovery(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	let sleepHours: string | null = null;
	const sleepSecs = entries.get("sleepSecs");
	const sleepHoursRaw = entries.get("sleepHours");
	if (sleepSecs !== null && sleepSecs !== undefined) {
		sleepHours = ((sleepSecs as number) / 3600).toFixed(2);
	} else if (sleepHoursRaw !== null && sleepHoursRaw !== undefined) {
		sleepHours = String(sleepHoursRaw);
	}
	if (sleepHours !== null) lines.push(`  Sleep: ${sleepHours} hours`);

	const sleepQuality = entries.get("sleepQuality");
	if (sleepQuality !== null && sleepQuality !== undefined) {
		const qualityLabels: Record<number, string> = { 1: "Great", 2: "Good", 3: "Average", 4: "Poor" };
		const qualityText = qualityLabels[sleepQuality as number] ?? String(sleepQuality);
		lines.push(`  Sleep Quality: ${sleepQuality} (${qualityText})`);
	}

	const sleepScore = entries.get("sleepScore");
	if (sleepScore !== null && sleepScore !== undefined) lines.push(`  Device Sleep Score: ${sleepScore}/100`);

	const readiness = entries.get("readiness");
	if (readiness !== null && readiness !== undefined) lines.push(`  Readiness: ${readiness}/10`);

	return lines;
}

function formatMenstrualTracking(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	const phase = entries.get("menstrualPhase");
	if (phase !== null && phase !== undefined) lines.push(`  Menstrual Phase: ${capitalize(String(phase))}`);
	const predicted = entries.get("menstrualPhasePredicted");
	if (predicted !== null && predicted !== undefined) lines.push(`  Predicted Phase: ${capitalize(String(predicted))}`);
	return lines;
}

function formatSubjectiveFeelings(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	for (const [k, label] of [
		["soreness", "Soreness"],
		["fatigue", "Fatigue"],
		["stress", "Stress"],
		["mood", "Mood"],
		["motivation", "Motivation"],
		["injury", "Injury Level"],
	]) {
		const v = entries.get(k);
		if (v !== null && v !== undefined) lines.push(`  ${label}: ${v}/10`);
	}
	return lines;
}

function formatNutritionHydration(entries: TrackedEntries): string[] {
	const lines: string[] = [];
	for (const [k, label] of [
		["kcalConsumed", "Calories Consumed"],
		["hydrationVolume", "Hydration Volume"],
	]) {
		const v = entries.get(k);
		if (v !== null && v !== undefined) lines.push(`- ${label}: ${v}`);
	}
	const hydration = entries.get("hydration");
	if (hydration !== null && hydration !== undefined) lines.push(`  Hydration Score: ${hydration}/10`);
	return lines;
}

function formatOtherFields(entries: TrackedEntries, knownKeys: Set<string>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(entries.data)) {
		if (!knownKeys.has(key) && value !== null && value !== undefined) {
			if (isRecord(value) || Array.isArray(value)) {
				lines.push(`- ${key}: ${JSON.stringify(value)}`);
			} else {
				lines.push(`- ${key}: ${value}`);
			}
		}
	}
	return lines;
}

function formatWellnessEntry(rawEntries: Activity, fields: Set<string> | undefined, includeAllFields: boolean): string {
	const includeAll = !fields || fields.size === 0;
	const entries = new TrackedEntries(rawEntries, includeAllFields);
	if (includeAllFields) {
		entries.get("date");
		entries.get("updated");
	}

	const lines: string[] = ["Wellness Data:"];
	lines.push(`Date: ${entries.get("id") ?? "N/A"}`);
	lines.push("");

	if (includeAll || fields!.has("training")) {
		const l = formatTrainingMetrics(entries);
		if (l.length) {
			lines.push("Training Metrics:", ...l, "");
		}
	}

	if (includeAll || fields!.has("sport_info")) {
		const l = formatSportInfo(entries);
		if (l.length) {
			lines.push("Sport-Specific Info:", ...l, "");
		}
	}

	if (includeAll || fields!.has("vital_signs")) {
		const l = formatVitalSigns(entries);
		if (l.length) {
			lines.push("Vital Signs:", ...l, "");
		}
	}

	if (includeAll || fields!.has("sleep")) {
		const l = formatSleepRecovery(entries);
		if (l.length) {
			lines.push("Sleep & Recovery:", ...l, "");
		}
	}

	if (includeAll || fields!.has("menstrual")) {
		const l = formatMenstrualTracking(entries);
		if (l.length) {
			lines.push("Menstrual Tracking:", ...l, "");
		}
	}

	if (includeAll || fields!.has("subjective")) {
		const l = formatSubjectiveFeelings(entries);
		if (l.length) {
			lines.push("Subjective Feelings:", ...l, "");
		}
	}

	if (includeAll || fields!.has("nutrition")) {
		const l = formatNutritionHydration(entries);
		if (l.length) {
			lines.push("Nutrition & Hydration:", ...l, "");
		}
	}

	if (includeAll || fields!.has("activity")) {
		const steps = entries.get("steps");
		if (steps !== null && steps !== undefined) {
			lines.push("Activity:", `- Steps: ${steps}`, "");
		}
	}

	const comments = entries.get("comments");
	if (comments) lines.push(`Comments: ${comments}`);
	if (entries.has("locked")) lines.push(`Status: ${entries.get("locked") ? "Locked" : "Unlocked"}`);

	if (includeAllFields) {
		const otherLines = formatOtherFields(entries, entries.accessed);
		if (otherLines.length) {
			lines.push("", "Other Fields:", ...otherLines);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Training summary aggregation (ported from Python tools/training_summary.py)
// ---------------------------------------------------------------------------

const NON_TRAINING_CATEGORIES = new Set(["HOLIDAY", "NOTE"]);

function round1(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return isNaN(n) ? null : roundTo(n, 1);
}

function round2(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return isNaN(n) ? null : roundTo(n, 2);
}

function stripNulls<T extends Record<string, unknown>>(d: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(d)) {
		if (v === null || v === undefined) continue;
		if ((Array.isArray(v) || isRecord(v)) && Object.keys(v).length === 0) continue;
		out[k] = v;
	}
	return out as T;
}

function setIf(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
	options: { positive?: boolean; transform?: (v: unknown) => unknown } = {},
): void {
	if (value === null || value === undefined) return;
	if (options.positive && !((value as number) > 0)) return;
	const result = options.transform ? options.transform(value) : value;
	if (result !== null && result !== undefined) target[key] = result;
}

function parseYMD(dateStr: string): Date {
	return new Date(`${dateStr}T00:00:00Z`);
}

function formatYMD(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addDaysUTC(d: Date, days: number): Date {
	return new Date(d.getTime() + days * 86400000);
}

interface SportAgg {
	count: number;
	tss: number;
	duration_secs: number;
	distance_m: number;
}

function buildPlannedSummary(events: Activity[]): Record<string, unknown> {
	let sessions = 0;
	let tss = 0;
	let duration = 0;
	let distance = 0;
	const sportAgg: Record<string, SportAgg> = {};

	for (const ev of events) {
		const cat = String(ev["category"] ?? "").toUpperCase();
		if (NON_TRAINING_CATEGORIES.has(cat)) continue;

		sessions += 1;
		const evTss = Number(ev["icu_training_load"] ?? 0) || 0;
		const evDuration = Number(ev["moving_time"] ?? 0) || 0;
		const evDistance = Number(ev["distance"] ?? 0) || 0;
		tss += evTss;
		duration += evDuration;
		distance += evDistance;

		const sport = (ev["type"] as string) || (ev["category"] as string) || "Other";
		const agg = sportAgg[sport] ?? (sportAgg[sport] = { count: 0, tss: 0, duration_secs: 0, distance_m: 0 });
		agg.count += 1;
		agg.tss += evTss;
		agg.duration_secs += evDuration;
		agg.distance_m += evDistance;
	}

	const bySport: Record<string, unknown> = {};
	for (const [name, a] of Object.entries(sportAgg)) {
		const sportEntry: Record<string, unknown> = {
			count: a.count,
			tss: round1(a.tss),
			duration_secs: a.duration_secs,
		};
		setIf(sportEntry, "distance_m", a.distance_m, { positive: true, transform: (v) => round1(v) });
		bySport[name] = stripNulls(sportEntry);
	}

	const result: Record<string, unknown> = { sessions, tss: round1(tss), duration_secs: duration };
	setIf(result, "distance_m", distance, { positive: true, transform: (v) => round1(v) });
	if (Object.keys(bySport).length) result["by_sport"] = bySport;
	return stripNulls(result);
}

function groupEventsByWeek(events: Activity[], summaryWeeks: Activity[]): Record<string, Activity[]> {
	const weekStarts = summaryWeeks
		.map((w) => (w["date"] ? parseYMD(String(w["date"])) : null))
		.filter((d): d is Date => d !== null)
		.sort((a, b) => a.getTime() - b.getTime());

	const grouped: Record<string, Activity[]> = {};
	for (const ws of weekStarts) grouped[formatYMD(ws)] = [];

	for (const ev of events) {
		const dateStr = ev["start_date_local"];
		if (!dateStr || typeof dateStr !== "string") continue;
		const evDate = parseYMD(dateStr.slice(0, 10));
		if (isNaN(evDate.getTime())) continue;
		for (let i = weekStarts.length - 1; i >= 0; i--) {
			const ws = weekStarts[i];
			const we = addDaysUTC(ws, 6);
			if (ws.getTime() <= evDate.getTime() && evDate.getTime() <= we.getTime()) {
				grouped[formatYMD(ws)].push(ev);
				break;
			}
		}
	}

	return grouped;
}

function buildBySport(categories: Activity[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const cat of categories) {
		const name = cat["category"];
		if (!name || typeof name !== "string") continue;
		const sport: Record<string, unknown> = {
			count: cat["count"] ?? 0,
			tss: round1(cat["training_load"]),
			duration_secs: cat["time"] ?? 0,
		};
		setIf(sport, "distance_m", cat["distance"], { positive: true, transform: (v) => round1(v) });
		setIf(sport, "elevation_m", cat["total_elevation_gain"], { positive: true, transform: (v) => round1(v) });
		setIf(sport, "eftp_w", cat["eftp"], { transform: (v) => round1(v) });
		setIf(sport, "eftp_w_kg", cat["eftpPerKg"], { transform: (v) => round1(v) });
		result[name] = stripNulls(sport);
	}
	return result;
}

interface PeriodSportAgg {
	count: number;
	tss: number;
	duration_secs: number;
	distance_m: number;
	elevation_m: number;
}

function buildPeriodTotals(weeks: Activity[]): Record<string, unknown> {
	let sessions = 0;
	let duration = 0;
	let tss = 0;
	let srpe = 0;
	let distance = 0;
	let elevation = 0;
	const sportAgg: Record<string, PeriodSportAgg> = {};

	for (const w of weeks) {
		sessions += Number(w["count"] ?? 0);
		duration += Number(w["time"] ?? 0);
		tss += Number(w["training_load"] ?? 0) || 0;
		srpe += Number(w["srpe"] ?? 0) || 0;
		distance += Number(w["distance"] ?? 0) || 0;
		elevation += Number(w["total_elevation_gain"] ?? 0) || 0;

		const byCategory = Array.isArray(w["byCategory"]) ? (w["byCategory"] as Activity[]) : [];
		for (const cat of byCategory) {
			const name = cat["category"];
			if (!name || typeof name !== "string") continue;
			const agg = sportAgg[name] ?? (sportAgg[name] = { count: 0, tss: 0, duration_secs: 0, distance_m: 0, elevation_m: 0 });
			agg.count += Number(cat["count"] ?? 0);
			agg.tss += Number(cat["training_load"] ?? 0) || 0;
			agg.duration_secs += Number(cat["time"] ?? 0);
			agg.distance_m += Number(cat["distance"] ?? 0) || 0;
			agg.elevation_m += Number(cat["total_elevation_gain"] ?? 0) || 0;
		}
	}

	const bySport: Record<string, unknown> = {};
	for (const [name, agg] of Object.entries(sportAgg)) {
		const sport: Record<string, unknown> = {
			count: agg.count,
			tss: round1(agg.tss),
			duration_secs: agg.duration_secs,
		};
		setIf(sport, "distance_m", agg.distance_m, { positive: true, transform: (v) => round1(v) });
		setIf(sport, "elevation_m", agg.elevation_m, { positive: true, transform: (v) => round1(v) });
		bySport[name] = stripNulls(sport);
	}

	const totals: Record<string, unknown> = {
		sessions,
		duration_secs: duration,
		tss: round1(tss),
		srpe: round1(srpe),
	};
	setIf(totals, "distance_m", distance, { positive: true, transform: (v) => round1(v) });
	setIf(totals, "elevation_m", elevation, { positive: true, transform: (v) => round1(v) });
	if (Object.keys(bySport).length) totals["by_sport"] = bySport;

	return stripNulls(totals);
}

function computeWeeklyCompliance(activities: Activity[], weekStart: string, weekEnd: string): number | null {
	const ws = parseYMD(weekStart).getTime();
	const we = parseYMD(weekEnd).getTime();

	const values: number[] = [];
	for (const act of activities) {
		const dateStr = act["start_date_local"];
		if (!dateStr || typeof dateStr !== "string") continue;
		const actDate = parseYMD(dateStr.slice(0, 10)).getTime();
		if (isNaN(actDate)) continue;
		if (ws <= actDate && actDate <= we) {
			const comp = act["compliance"];
			if (comp !== null && comp !== undefined) {
				const n = Number(comp);
				if (!isNaN(n)) values.push(n);
			}
		}
	}

	if (!values.length) return null;
	return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function computeWeeklyWellness(wellnessData: Activity[], weekStart: string, weekEnd: string): Record<string, number> {
	const ws = parseYMD(weekStart).getTime();
	const we = parseYMD(weekEnd).getTime();

	const fieldMap: Record<string, string> = {
		hrvRMSSD: "hrv",
		restingHR: "resting_hr_bpm",
		sleepSecs: "_sleep_secs",
		fatigue: "fatigue",
		mood: "mood",
	};

	const sums: Record<string, number> = {};
	const counts: Record<string, number> = {};

	for (const entry of wellnessData) {
		const dateStr = (entry["id"] as string | undefined) ?? (entry["date"] as string | undefined) ?? "";
		if (!dateStr) continue;
		const d = parseYMD(String(dateStr).slice(0, 10)).getTime();
		if (isNaN(d)) continue;
		if (ws <= d && d <= we) {
			for (const [apiField, outKey] of Object.entries(fieldMap)) {
				const val = entry[apiField];
				if (val !== null && val !== undefined) {
					const n = Number(val);
					if (!isNaN(n)) {
						sums[outKey] = (sums[outKey] ?? 0) + n;
						counts[outKey] = (counts[outKey] ?? 0) + 1;
					}
				}
			}
		}
	}

	const result: Record<string, number> = {};
	for (const key of Object.keys(sums)) {
		const avg = sums[key] / counts[key];
		if (key === "_sleep_secs") {
			result["sleep_hrs"] = roundTo(avg / 3600, 1);
		} else {
			result[key] = roundTo(avg, 1);
		}
	}
	return result;
}

function buildWeeks(
	summaryWeeks: Activity[],
	activities: Activity[],
	wellnessData: Activity[],
	eventsByWeek: Record<string, Activity[]>,
	today: Date,
): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	const todayTime = parseYMD(formatYMD(today)).getTime();

	for (const w of summaryWeeks) {
		const dateStr = w["date"];
		if (!dateStr || typeof dateStr !== "string") continue;

		const weekStartDt = parseYMD(dateStr);
		const weekEndDt = addDaysUTC(weekStartDt, 6);
		const weekStart = dateStr;
		const weekEnd = formatYMD(weekEndDt);

		const isFuture = weekStartDt.getTime() > todayTime;
		const partial = !isFuture && weekEndDt.getTime() > todayTime;

		const week: Record<string, unknown> = { week_start: weekStart, week_end: weekEnd };
		if (partial) week["partial"] = true;

		const weekEvents = eventsByWeek[weekStart] ?? [];
		if (weekEvents.length) {
			const planned = buildPlannedSummary(weekEvents);
			if ((planned["sessions"] as number) > 0) week["planned"] = planned;

			for (const ev of weekEvents) {
				const cat = String(ev["category"] ?? "").toUpperCase();
				if (cat === "HOLIDAY") {
					const evDateStr = ev["start_date_local"];
					const holidayDate = typeof evDateStr === "string" ? evDateStr.slice(0, 10) : null;
					if (holidayDate) {
						((week["holiday"] as string[] | undefined) ?? (week["holiday"] = [])).push(holidayDate);
					}
				} else if (cat === "NOTE") {
					const noteText = (ev["name"] as string | undefined) || (ev["description"] as string | undefined) || "";
					if (noteText) {
						((week["notes"] as string[] | undefined) ?? (week["notes"] = [])).push(noteText);
					}
				}
			}
		}

		if (!isFuture) {
			const completed: Record<string, unknown> = {
				sessions: w["count"] ?? 0,
				tss: round1(w["training_load"]),
				srpe: round1(w["srpe"]),
				duration_secs: w["time"] ?? 0,
			};

			const compliance = computeWeeklyCompliance(activities, weekStart, weekEnd);
			if (compliance !== null) completed["compliance_pct"] = compliance;

			const byCat = Array.isArray(w["byCategory"]) ? (w["byCategory"] as Activity[]) : [];
			if (byCat.length) completed["by_sport"] = buildBySport(byCat);

			week["completed"] = stripNulls(completed);
		}

		week["ramp_rate"] = round1(w["rampRate"]);
		week["ctl"] = round1(w["fitness"]);
		week["atl"] = round1(w["fatigue"]);
		week["tsb"] = round1(w["form"]);

		if (!isFuture) {
			const wellness = computeWeeklyWellness(wellnessData, weekStart, weekEnd);
			if (Object.keys(wellness).length) week["wellness"] = wellness;
		}

		result.push(stripNulls(week));
	}

	return result;
}

function buildTrainingSummaryResult(
	summaryWeeks: Activity[],
	activities: Activity[],
	wellnessData: Activity[],
	events: Activity[],
	startDate: string,
	endDate: string,
	today: Date,
): Record<string, unknown> {
	if (!summaryWeeks.length) return { period: { start: startDate, end: endDate } };

	const oldest = summaryWeeks[0];
	const newest = summaryWeeks[summaryWeeks.length - 1];

	const startCtl = round1(oldest["fitness"]);
	const startAtl = round1(oldest["fatigue"]);
	const startTsb = round1(oldest["form"]);

	const currentCtl = round1(newest["fitness"]);
	const currentAtl = round1(newest["fatigue"]);
	const currentTsb = round1(newest["form"]);

	let acRatio: number | null = null;
	if (currentAtl !== null && currentCtl !== null && currentCtl !== 0) {
		acRatio = round2(currentAtl / currentCtl);
	}

	const load: Record<string, unknown> = {
		start: stripNulls({ ctl: startCtl, atl: startAtl, tsb: startTsb }),
		end: stripNulls({ ctl: currentCtl, atl: currentAtl, tsb: currentTsb }),
	};
	if (acRatio !== null) load["ac_ratio"] = acRatio;

	const eventsByWeek = groupEventsByWeek(events, summaryWeeks);

	const result: Record<string, unknown> = {
		period: { start: startDate, end: endDate },
		load: stripNulls(load),
		period_totals: buildPeriodTotals(summaryWeeks),
		weeks: buildWeeks(summaryWeeks, activities, wellnessData, eventsByWeek, today),
	};

	return stripNulls(result);
}

// ---------------------------------------------------------------------------
// Power curve formatting (ported from Python tools/power_curves.py)
// ---------------------------------------------------------------------------

const DEFAULT_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 3600];

function buildCurvesParam(thisSeason: boolean, lastSeason: boolean, startDate: string | undefined, endDate: string | undefined): string[] {
	const curves: string[] = [];
	if (thisSeason) curves.push("s0");
	if (lastSeason) curves.push("s1");
	if (startDate && endDate) curves.push(`r.${startDate}.${endDate}`);
	return curves;
}

function validatePowerCurveDates(startDate: string | undefined, endDate: string | undefined): string | null {
	if (Boolean(startDate) !== Boolean(endDate)) {
		return "Error: Both start_date and end_date must be provided together for a custom date range.";
	}
	if (startDate && endDate) {
		if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
			return "Error: Dates must be in YYYY-MM-DD format.";
		}
		if (parseYMD(startDate).getTime() >= parseYMD(endDate).getTime()) {
			return "Error: start_date must be before end_date.";
		}
	}
	return null;
}

function extractCurveData(curve: Activity, durations: number[], includeNormalised: boolean): Record<string, unknown> {
	const secs = Array.isArray(curve["secs"]) ? (curve["secs"] as number[]) : [];
	const values = Array.isArray(curve["values"]) ? (curve["values"] as number[]) : [];
	const activityIds = Array.isArray(curve["activity_id"]) ? (curve["activity_id"] as unknown[]) : [];
	const wattsPerKg = Array.isArray(curve["watts_per_kg"]) ? (curve["watts_per_kg"] as number[]) : [];
	const wkgActivityIds = Array.isArray(curve["wkg_activity_id"]) ? (curve["wkg_activity_id"] as unknown[]) : [];

	const secToIdx = new Map<number, number>();
	secs.forEach((s, i) => secToIdx.set(s, i));

	const dataPoints: Record<string, unknown>[] = [];
	for (const dur of durations) {
		const idx = secToIdx.get(dur);
		if (idx === undefined || idx >= values.length) continue;
		const point: Record<string, unknown> = {
			secs: dur,
			watts: values[idx],
			activity_id: idx < activityIds.length ? activityIds[idx] : null,
		};
		if (includeNormalised && idx < wattsPerKg.length) {
			point["watts_per_kg"] = roundTo(wattsPerKg[idx], 2);
			point["wkg_activity_id"] = idx < wkgActivityIds.length ? wkgActivityIds[idx] : null;
		}
		dataPoints.push(point);
	}

	return {
		id: curve["id"] ?? "",
		label: curve["label"] ?? curve["id"] ?? "",
		start: curve["start_date_local"] ?? "",
		end: curve["end_date_local"] ?? "",
		data_points: dataPoints,
	};
}

function formatDurationLabel(secs: number): string {
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) {
		const mins = Math.floor(secs / 60);
		const remainder = secs % 60;
		return remainder ? `${mins}m${remainder}s` : `${mins}m`;
	}
	const hours = Math.floor(secs / 3600);
	const remainder = Math.floor((secs % 3600) / 60);
	return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}

function formatPowerCurves(curves: Record<string, unknown>[], activityType: string, includeNormalised: boolean): string {
	const lines: string[] = [`Power Curves (${activityType}):`, ""];

	for (const curve of curves) {
		const label = curve["label"] ?? curve["id"] ?? "Unknown";
		const start = String(curve["start"] ?? "");
		const end = String(curve["end"] ?? "");
		let dateRange = "";
		if (start && end) {
			const startShort = start.length > 10 ? start.slice(0, 10) : start;
			const endShort = end.length > 10 ? end.slice(0, 10) : end;
			dateRange = ` (${startShort} to ${endShort})`;
		}

		lines.push(`${label}${dateRange}:`);

		const dataPoints = (curve["data_points"] as Record<string, unknown>[]) ?? [];
		if (!dataPoints.length) {
			lines.push("  No data available for requested durations.", "");
			continue;
		}

		for (const point of dataPoints) {
			const durLabel = formatDurationLabel(point["secs"] as number);
			const watts = point["watts"];
			const aid = point["activity_id"] ?? "";
			const parts = [`  ${durLabel}: ${watts}W`];
			if (includeNormalised && "watts_per_kg" in point) {
				parts.push(`${(point["watts_per_kg"] as number).toFixed(2)}W/kg`);
				const wkgAid = point["wkg_activity_id"] ?? "";
				if (wkgAid && wkgAid !== aid) {
					parts.push(`[${aid}|wkg:${wkgAid}]`);
				} else {
					parts.push(`[${aid}]`);
				}
			} else {
				parts.push(`[${aid}]`);
			}
			lines.push(parts.join(" "));
		}
		lines.push("");
	}

	return lines.join("\n");
}

function resolveActivityType(name: string): string {
	const nameLower = name ? name.toLowerCase() : "";
	const mapping: [string, string[]][] = [
		["Ride", ["bike", "cycle", "cycling", "ride"]],
		["Run", ["run", "running", "jog", "jogging"]],
		["Swim", ["swim", "swimming", "pool"]],
		["Walk", ["walk", "walking", "hike", "hiking"]],
		["Row", ["row", "rowing"]],
	];
	for (const [workout, keywords] of mapping) {
		if (keywords.some((k) => nameLower.includes(k))) return workout;
	}
	return "Ride";
}

// ---------------------------------------------------------------------------
// Athlete zones (ported from Python tools/athlete.py)
// ---------------------------------------------------------------------------

const SENTINEL_PCT = 900;

function buildPowerZones(ftp: number, zonePcts: number[], zoneNames: string[]): Record<string, unknown>[] {
	const zones: Record<string, unknown>[] = [];
	let prevW = 0;
	for (let i = 0; i < zoneNames.length; i++) {
		if (i >= zonePcts.length) break;
		const pct = zonePcts[i];
		const zone: Record<string, unknown> = { name: zoneNames[i], min_w: prevW };
		if (pct < SENTINEL_PCT) {
			const maxW = Math.round((ftp * pct) / 100);
			zone["max_w"] = maxW;
			prevW = maxW + 1;
		}
		zones.push(zone);
	}
	return zones;
}

function buildHrZones(hrBoundaries: number[], zoneNames: string[]): Record<string, unknown>[] {
	const zones: Record<string, unknown>[] = [];
	let prevBpm = 0;
	for (let i = 0; i < zoneNames.length; i++) {
		if (i >= hrBoundaries.length) break;
		const maxBpm = Math.trunc(hrBoundaries[i]);
		zones.push({ name: zoneNames[i], min_bpm: prevBpm, max_bpm: maxBpm });
		prevBpm = maxBpm + 1;
	}
	return zones;
}

function msToMinKmStr(ms: number): string {
	if (ms <= 0) throw new Error("Speed must be positive for pace conversion");
	const secsPerKm = 1000.0 / ms;
	let minutes = Math.floor(secsPerKm / 60);
	let seconds = Math.round(secsPerKm % 60);
	if (seconds === 60) {
		minutes += 1;
		seconds = 0;
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function msToSec100m(ms: number): number {
	if (ms <= 0) throw new Error("Speed must be positive for pace conversion");
	return roundTo(100.0 / ms, 1);
}

function buildPaceZones(
	thresholdPace: number,
	zonePcts: number[],
	zoneNames: string[],
	paceUnits: string | undefined,
): Record<string, unknown>[] {
	const speedBounds: (number | null)[] = zonePcts.map((pct) => (pct < SENTINEL_PCT ? (thresholdPace * pct) / 100 : null));

	const zones: Record<string, unknown>[] = [];
	for (let i = 0; i < zoneNames.length; i++) {
		if (i >= speedBounds.length) break;

		const zone: Record<string, unknown> = { name: zoneNames[i] };
		const fastSpeed = speedBounds[i];
		const slowSpeed = i > 0 ? speedBounds[i - 1] : null;

		if (paceUnits === "MINS_KM") {
			if (fastSpeed !== null) zone["min_minkm"] = msToMinKmStr(fastSpeed);
			if (slowSpeed !== null) zone["max_minkm"] = msToMinKmStr(slowSpeed);
		} else if (paceUnits === "SECS_100M") {
			if (fastSpeed !== null) zone["min_sec100m"] = msToSec100m(fastSpeed);
			if (slowSpeed !== null) zone["max_sec100m"] = msToSec100m(slowSpeed);
		} else {
			if (slowSpeed !== null) zone["min_ms"] = roundTo(slowSpeed + 0.01, 2);
			else zone["min_ms"] = 0.0;
			if (fastSpeed !== null) zone["max_ms"] = roundTo(fastSpeed, 2);
		}

		zones.push(zone);
	}
	return zones;
}

function extractSportZones(setting: Activity): Record<string, unknown> {
	const types = Array.isArray(setting["types"]) ? (setting["types"] as string[]) : [];
	const sport = types.length ? types[0] : "Unknown";

	const result: Record<string, unknown> = { sport, types };

	const updated = setting["updated"];
	if (updated !== null && updated !== undefined) result["last_updated"] = updated;

	const thresholds: Record<string, unknown> = {};
	const ftp = setting["ftp"] as number | undefined;
	if (ftp !== null && ftp !== undefined) thresholds["ftp_w"] = ftp;
	const lthr = setting["lthr"];
	if (lthr !== null && lthr !== undefined) thresholds["lthr_bpm"] = lthr;
	const maxHr = setting["max_hr"];
	if (maxHr !== null && maxHr !== undefined) thresholds["max_hr_bpm"] = maxHr;
	const thresholdPace = setting["threshold_pace"] as number | undefined;
	let paceUnits: string | undefined;
	if (thresholdPace !== null && thresholdPace !== undefined) {
		thresholds["threshold_pace_ms"] = roundTo(thresholdPace, 2);
		paceUnits = setting["pace_units"] as string | undefined;
		if (paceUnits) {
			thresholds["pace_units"] = paceUnits;
			if (paceUnits === "MINS_KM") thresholds["threshold_pace_minkm"] = msToMinKmStr(thresholdPace);
			else if (paceUnits === "SECS_100M") thresholds["threshold_pace_sec100m"] = msToSec100m(thresholdPace);
		}
	}
	if (Object.keys(thresholds).length) result["thresholds"] = thresholds;

	const powerZonesPcts = setting["power_zones"];
	const powerZoneNames = setting["power_zone_names"];
	if (ftp && Array.isArray(powerZonesPcts) && Array.isArray(powerZoneNames) && powerZonesPcts.length && powerZoneNames.length) {
		result["power_zones"] = buildPowerZones(ftp, powerZonesPcts as number[], powerZoneNames as string[]);
	}

	const hrZonesVals = setting["hr_zones"];
	const hrZoneNames = setting["hr_zone_names"];
	if (Array.isArray(hrZonesVals) && Array.isArray(hrZoneNames) && hrZonesVals.length && hrZoneNames.length) {
		result["hr_zones"] = buildHrZones(hrZonesVals as number[], hrZoneNames as string[]);
	}

	const paceZonesPcts = setting["pace_zones"];
	const paceZoneNames = setting["pace_zone_names"];
	if (thresholdPace && Array.isArray(paceZonesPcts) && Array.isArray(paceZoneNames) && paceZonesPcts.length && paceZoneNames.length) {
		result["pace_zones"] = buildPaceZones(thresholdPace, paceZonesPcts as number[], paceZoneNames as string[], paceUnits);
	}

	return result;
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
						activity[field] = dt.toLocaleString("sv-SE", { timeZone: timezone }).replace("T", " ");
					}
				} catch {
					// keep original
				}
			}
		}
	}
	return activities;
}

function formatActivitiesResponse(activities: Activity[], athleteId: string, includeUnnamed: boolean, compact: boolean): string {
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
// Event formatting (ported from Python utils/formatting.py event helpers)
// ---------------------------------------------------------------------------

const VALID_EVENT_CATEGORIES = new Set([
	"WORKOUT",
	"RACE_A",
	"RACE_B",
	"RACE_C",
	"NOTE",
	"PLAN",
	"HOLIDAY",
	"SICK",
	"INJURED",
	"SET_EFTP",
	"FITNESS_DAYS",
	"SEASON_START",
	"TARGET",
	"SET_FITNESS",
]);

function parseISODate(raw: string): Date | null {
	const dt = new Date(raw);
	return isNaN(dt.getTime()) ? null : dt;
}

function normaliseDate(raw: unknown): string {
	if (typeof raw === "string" && raw.length > 10) {
		const dt = parseISODate(raw);
		if (dt) return dt.toISOString().slice(0, 10);
	}
	return String(raw);
}

function isMultiDay(startRaw: string, endRaw: string): boolean {
	const startDt = parseISODate(startRaw);
	const endDt = parseISODate(endRaw);
	if (!startDt || !endDt) return normaliseDate(endRaw) > normaliseDate(startRaw);
	const deltaSecs = (endDt.getTime() - startDt.getTime()) / 1000;
	return deltaSecs > 86400;
}

function getEventDate(event: Activity): string {
	const startRaw = event["start_date_local"] ?? event["date"] ?? "Unknown";
	const start = normaliseDate(startRaw);
	const endRaw = event["end_date_local"];
	if (endRaw !== null && endRaw !== undefined && isMultiDay(String(startRaw), String(endRaw))) {
		return `${start} to ${normaliseDate(endRaw)}`;
	}
	return start;
}

function titleCase(s: string): string {
	return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function getEventType(event: Activity): string {
	const category = event["category"];
	if (category && category === "WORKOUT") return "Workout";
	if (category === null || category === undefined) return "Other";
	return titleCase(String(category).replace(/_/g, " "));
}

function eventRound1(value: unknown): unknown {
	if (typeof value === "number" && !Number.isInteger(value)) return roundTo(value, 1);
	return value;
}

function formatEventLoadFields(event: Activity): string[] {
	const lines: string[] = [];
	addField(lines, "Training Load", eventRound1(event["icu_training_load"]));
	addField(lines, "ATL", eventRound1(event["icu_atl"]));
	addField(lines, "CTL", eventRound1(event["icu_ctl"]));
	addField(lines, "Intensity", eventRound1(event["icu_intensity"]));
	addField(lines, "Strain", eventRound1(event["strain_score"]));
	return lines;
}

function formatEventCompact(event: Activity): string {
	const eventDate = getEventDate(event);
	const eventType = getEventType(event);
	const eventName = event["name"] ?? "Unnamed";
	const eventId = event["id"] ?? "";

	const parts = [`${eventDate} | ${eventType}: ${eventName} (ID:${eventId})`];

	const tl = event["icu_training_load"];
	if (tl !== null && tl !== undefined) parts.push(`TL:${eventRound1(tl)}`);

	const atl = event["icu_atl"];
	if (atl !== null && atl !== undefined) parts.push(`ATL:${eventRound1(atl)}`);

	const ctl = event["icu_ctl"];
	if (ctl !== null && ctl !== undefined) parts.push(`CTL:${eventRound1(ctl)}`);

	const intensity = event["icu_intensity"];
	if (intensity !== null && intensity !== undefined) parts.push(`Int:${eventRound1(intensity)}`);

	const strain = event["strain_score"];
	if (strain !== null && strain !== undefined) parts.push(`Strain:${eventRound1(strain)}`);

	return parts.join(" | ");
}

function formatEventSummary(event: Activity): string {
	const eventDate = getEventDate(event);
	const eventType = getEventType(event);
	const eventName = event["name"] ?? "Unnamed";
	const eventId = event["id"] ?? "N/A";
	const eventDesc = event["description"] ?? "No description";

	const lines = [`Date: ${eventDate}`, `ID: ${eventId}`, `Type: ${eventType}`, `Name: ${eventName}`];

	const loadLines = formatEventLoadFields(event);
	if (loadLines.length > 0) lines.push(...loadLines);

	lines.push(`Description: ${eventDesc}`);

	return lines.join("\n").replace(/\n+$/, "") + "\n\n";
}

function formatEventDetails(event: Activity): string {
	let details = `Event Details:\n\nID: ${event["id"] ?? "N/A"}\nDate: ${event["date"] ?? "Unknown"}\nName: ${event["name"] ?? "Unnamed"}\nDescription: ${event["description"] ?? "No description"}`;

	if (event["workout"]) {
		const workout = event["workout"] as Activity;
		details += `\n\nWorkout Information:\nWorkout ID: ${workout["id"] ?? "N/A"}\nSport: ${workout["sport"] ?? "Unknown"}\nDuration: ${workout["duration"] ?? 0} seconds\nTSS: ${workout["tss"] ?? "N/A"}`;
		if (Array.isArray(workout["intervals"])) {
			details += `\nIntervals: ${(workout["intervals"] as unknown[]).length}`;
		}
	}

	if (event["race"]) {
		details += `\n\nRace Information:\nPriority: ${event["priority"] ?? "N/A"}\nResult: ${event["result"] ?? "N/A"}`;
	}

	if ("calendar" in event) {
		const cal = event["calendar"] as Activity | undefined;
		details += `\n\nCalendar: ${cal?.["name"] ?? "N/A"}`;
	}

	return details;
}

// ---------------------------------------------------------------------------
// Custom item formatting (ported from Python utils/formatting.py)
// ---------------------------------------------------------------------------

function formatCustomItemDetails(item: Activity): string {
	const lines = ["Custom Item Details:", ""];
	lines.push(`ID: ${item["id"] ?? "N/A"}`);
	lines.push(`Name: ${item["name"] ?? "N/A"}`);
	lines.push(`Type: ${item["type"] ?? "N/A"}`);

	if (item["description"]) lines.push(`Description: ${item["description"]}`);
	if (item["visibility"]) lines.push(`Visibility: ${item["visibility"]}`);
	if (item["index"] !== null && item["index"] !== undefined) lines.push(`Index: ${item["index"]}`);
	if (item["hide_script"] !== null && item["hide_script"] !== undefined) lines.push(`Hide Script: ${item["hide_script"]}`);
	if (item["content"]) lines.push(`Content: ${JSON.stringify(item["content"], null, 2)}`);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workout DSL serialization (ported from Python utils/types.py Value/Step/WorkoutDoc.__str__)
// ---------------------------------------------------------------------------

interface WorkoutValueInput {
	value?: number;
	start?: number;
	end?: number;
	units?: string;
	target?: string;
}

interface WorkoutStepInput {
	text?: string;
	text_locale?: Record<string, string>;
	duration?: number;
	distance?: number;
	until_lap_press?: boolean;
	reps?: number;
	warmup?: boolean;
	cooldown?: boolean;
	intensity?: string;
	steps?: WorkoutStepInput[];
	ramp?: boolean;
	freeride?: boolean;
	maxeffort?: boolean;
	power?: WorkoutValueInput;
	hr?: WorkoutValueInput;
	pace?: WorkoutValueInput;
	cadence?: WorkoutValueInput;
	hidepower?: boolean;
}

interface WorkoutDocInput {
	description?: string;
	description_locale?: Record<string, string>;
	duration?: number;
	distance?: number;
	ftp?: number;
	lthr?: number;
	threshold_pace?: number;
	pace_units?: string;
	category?: string;
	target?: string;
	steps?: WorkoutStepInput[];
	zone_times?: unknown[];
	options?: Record<string, string>;
	locales?: string[];
}

const WORKOUT_PERCENT_UNITS = new Set(["%hr", "%mmp", "%lthr", "%pace", "%ftp"]);
const WORKOUT_ZONE_UNITS = new Set(["power_zone", "hr_zone", "pace_zone"]);
const WORKOUT_UNITS_LABEL_MAP: Record<string, string> = {
	"%hr": "HR",
	hr_zone: "HR",
	"%mmp": "MMP",
	"%lthr": "LTHR",
	"%pace": "Pace",
	pace_zone: "Pace",
	"%ftp": "ftp",
	power_zone: "W",
	cadence: "Cadence",
};

function floatToStr(value: number): string {
	return String(value);
}

function formatWorkoutValue(value: number, units: string | undefined): string {
	if (units && WORKOUT_PERCENT_UNITS.has(units)) return `${floatToStr(value)}%`;
	if (units && WORKOUT_ZONE_UNITS.has(units)) return `Z${floatToStr(value)}`;
	if (units === "w") return `${floatToStr(value)}W`;
	if (units === "cadence") return `${floatToStr(value)}rpm`;
	return floatToStr(value);
}

function formatWorkoutUnits(units: string | undefined): string {
	if (!units) return "";
	return WORKOUT_UNITS_LABEL_MAP[units] ?? "";
}

function workoutValueToStr(v: WorkoutValueInput | undefined): string {
	if (!v) return "";
	let val = "";
	if (v.start !== undefined && v.end !== undefined) {
		val += `${formatWorkoutValue(v.start, v.units)}-${formatWorkoutValue(v.end, v.units)} `;
	}
	if (v.value !== undefined) {
		val += `${formatWorkoutValue(v.value, v.units)} `;
	}
	if (v.units !== undefined) {
		val += `${formatWorkoutUnits(v.units)} `;
	}
	if (v.target !== undefined) {
		val += `hr=${v.target} `;
	}
	return val.trim();
}

function formatStepDuration(duration: number | undefined): string {
	if (duration === undefined || duration === null) return "";
	let remaining = duration;
	let val = "";
	if (remaining > 3600) {
		val += `${Math.floor(remaining / 3600)}h`;
		remaining %= 3600;
	}
	if (remaining > 100 || remaining === 60) {
		val += `${Math.floor(remaining / 60)}m`;
		remaining %= 60;
	}
	if (remaining > 0) {
		val += `${remaining}s`;
	}
	return val;
}

function formatStepDistance(distance: number | undefined): string {
	if (distance === undefined || distance === null) return "";
	if (distance < 1000) return `${floatToStr(distance)}mtr`;
	return `${floatToStr(distance / 1000)}km`;
}

function workoutStepToStr(step: WorkoutStepInput, nested = false): string {
	let val = "";
	if (step.reps !== undefined && step.reps !== null) {
		if (nested) throw new Error("Nested steps not supported");
		val += `\n${step.reps}x `;
	} else {
		if (!nested && step.warmup) val += "\nWarmup\n";
		if (!nested && step.cooldown) val += "\nCooldown\n";

		if (step.duration !== undefined && step.duration !== null) {
			val += `- ${formatStepDuration(step.duration)} `;
		} else if (step.distance !== undefined && step.distance !== null) {
			val += `- ${formatStepDistance(step.distance)} `;
		}

		if (step.freeride) val += "freeride ";
		if (step.maxeffort) val += "maxeffort ";
		if (step.ramp) val += "ramp ";
		if (step.hidepower) val += "hidepower ";
		if (step.intensity !== undefined && step.intensity !== null) val += `intensity=${step.intensity} `;

		if (step.power) val += `${workoutValueToStr(step.power)} `;
		if (step.hr) val += `${workoutValueToStr(step.hr)} `;
		if (step.pace) val += `${workoutValueToStr(step.pace)} `;
		if (step.cadence) val += `${workoutValueToStr(step.cadence)} `;
	}

	if (step.text !== undefined && step.text !== null) val += `${step.text} `;

	if (step.reps !== undefined && step.reps !== null && step.steps) {
		for (const child of step.steps) {
			val += "\n" + workoutStepToStr(child, true);
		}
		val += "\n";
	} else if (!nested && (step.warmup || step.cooldown)) {
		val += "\n";
	}

	return val;
}

function workoutDocToStr(doc: WorkoutDocInput): string {
	let val = "";
	if (doc.description !== undefined && doc.description !== null) val += `${doc.description}\n`;
	if (doc.steps) {
		for (const step of doc.steps) {
			val += workoutStepToStr(step) + "\n";
		}
	}
	return val;
}

// ---------------------------------------------------------------------------
// Event API helpers (ported from Python tools/events.py)
// ---------------------------------------------------------------------------

function prepareEventData(
	name: string,
	workoutType: string,
	startDate: string,
	workoutDoc: WorkoutDocInput | undefined,
	movingTime: number | null,
	distance: number | null,
): Record<string, unknown> {
	const resolvedWorkoutType = workoutType ? workoutType : resolveActivityType(name);
	return {
		start_date_local: startDate + "T00:00:00",
		category: "WORKOUT",
		name,
		description: workoutDoc ? workoutDocToStr(workoutDoc) : null,
		type: resolvedWorkoutType,
		moving_time: movingTime,
		distance,
	};
}

function handleEventResponse(result: ApiResult, action: string, athleteId: string, startDate: string): string {
	if (!Array.isArray(result) && result["error"]) {
		const errorMessage = (result["message"] as string) ?? "Unknown error";
		return `Error ${action} event: ${errorMessage}`;
	}
	const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
	if (!result || isEmpty) {
		return `No events ${action} for athlete ${athleteId}.`;
	}
	if (!Array.isArray(result)) {
		let msg = `Successfully ${action} event id: ${result["id"]}`;
		const trainingLoad = result["icu_training_load"];
		const atl = result["icu_atl"];
		const ctl = result["icu_ctl"];
		if (trainingLoad !== null && trainingLoad !== undefined) msg += `, training load: ${trainingLoad}`;
		if (atl !== null && atl !== undefined) msg += `, fatigue (ATL): ${atl}`;
		if (ctl !== null && ctl !== undefined) msg += `, fitness (CTL): ${ctl}`;
		return msg;
	}
	return `Event ${action} successfully at ${startDate}`;
}

async function createOrUpdateEventRequest(
	apiKey: string,
	athleteId: string,
	eventData: Record<string, unknown>,
	startDate: string,
	eventId: string | undefined,
): Promise<string> {
	let url = `/athlete/${athleteId}/events`;
	if (eventId) url += `/${eventId}`;
	const result = await makeIntervalsRequest(apiKey, url, undefined, eventId ? "PUT" : "POST", eventData);
	const action = eventId ? "updated" : "created";
	return handleEventResponse(result, action, athleteId, startDate);
}

async function deleteEventsList(apiKey: string, athleteId: string, events: Activity[]): Promise<unknown[]> {
	const failedEvents: unknown[] = [];
	for (const event of events) {
		const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/events/${event["id"]}`, undefined, "DELETE");
		if (!Array.isArray(result) && result["error"]) {
			failedEvents.push(event["id"] ?? null);
		}
	}
	return failedEvents;
}

function validateDateStrict(dateStr: string): string {
	if (!isValidDateStr(dateStr)) {
		throw new Error("Invalid date format. Please use YYYY-MM-DD.");
	}
	return dateStr;
}

async function fetchEventsForDeletion(
	apiKey: string,
	athleteId: string,
	startDate: string,
	endDate: string,
): Promise<[Activity[], string | null]> {
	const params = { oldest: validateDateStrict(startDate), newest: validateDateStrict(endDate) };
	const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/events`, params);
	if (!Array.isArray(result) && result["error"]) {
		return [[], `Error deleting events: ${result["message"]}`];
	}
	const events = Array.isArray(result) ? (result as Activity[]) : [];
	return [events, null];
}

// ---------------------------------------------------------------------------
// Zod schemas for the workout DSL (Value / Step / WorkoutDoc)
// ---------------------------------------------------------------------------

const WorkoutValueSchema = z.object({
	value: z.number().optional().describe("Absolute or percentage value"),
	start: z.number().optional().describe("Start value for a range"),
	end: z.number().optional().describe("End value for a range"),
	units: z
		.string()
		.optional()
		.describe('Units: "%ftp", "%hr", "%lthr", "%pace", "%mmp", "w" (watts), "cadence", "power_zone", "hr_zone", or "pace_zone"'),
	target: z.string().optional().describe('HR averaging target: "lap", "1s", "3s", "10s", or "30s"'),
});

const WorkoutStepSchema: z.ZodTypeAny = z.lazy(() =>
	z.object({
		text: z.string().optional().describe("Comment or label text for this step"),
		text_locale: z.record(z.string(), z.string()).optional(),
		duration: z.number().optional().describe("Duration of step in seconds"),
		distance: z.number().optional().describe("Distance of step in meters"),
		until_lap_press: z.boolean().optional(),
		reps: z.number().optional().describe("Number of repeats; when set this step is a repeat block with nested steps"),
		warmup: z.boolean().optional(),
		cooldown: z.boolean().optional(),
		intensity: z.string().optional().describe('One of: "active", "rest", "warmup", "cooldown", "recovery", "interval", "other"'),
		steps: z.array(WorkoutStepSchema).optional().describe("Nested steps (used with reps for repeat blocks)"),
		ramp: z.boolean().optional().describe("Gradual change in intensity from start to end (for ERG workouts)"),
		freeride: z.boolean().optional().describe("Segment without ERG control"),
		maxeffort: z.boolean().optional(),
		power: WorkoutValueSchema.optional(),
		hr: WorkoutValueSchema.optional(),
		pace: WorkoutValueSchema.optional(),
		cadence: WorkoutValueSchema.optional(),
		hidepower: z.boolean().optional(),
	}),
);

const WorkoutDocSchema = z.object({
	description: z.string().optional().describe("Workout description"),
	description_locale: z.record(z.string(), z.string()).optional(),
	duration: z.number().optional(),
	distance: z.number().optional(),
	ftp: z.number().optional(),
	lthr: z.number().optional(),
	threshold_pace: z.number().optional().describe("Threshold pace in meters/sec"),
	pace_units: z.string().optional().describe('"SECS_100M", "SECS_100Y", "MINS_KM", "MINS_MILE", or "SECS_500M"'),
	category: z.string().optional(),
	target: z.string().optional().describe('"AUTO", "POWER", "HR", or "PACE"'),
	steps: z.array(WorkoutStepSchema).optional().describe("Ordered list of workout steps"),
	zone_times: z.array(z.unknown()).optional(),
	options: z.record(z.string(), z.string()).optional(),
	locales: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Workout DSL -> API dict serialization (ported from Python utils/types.py
// Value/Step/WorkoutDoc.to_dict()). Used by create_workout/update_workout,
// which send workout_doc as structured JSON rather than the DSL text used by
// add_or_update_event's event description.
// ---------------------------------------------------------------------------

function valueToDict(v: WorkoutValueInput | undefined): Record<string, unknown> | undefined {
	if (!v) return undefined;
	const data: Record<string, unknown> = {};
	if (v.value !== undefined) data["value"] = v.value;
	if (v.start !== undefined) data["start"] = v.start;
	if (v.end !== undefined) data["end"] = v.end;
	if (v.units !== undefined) data["units"] = v.units;
	if (v.target !== undefined) data["target"] = v.target;
	return data;
}

function stepToDict(step: WorkoutStepInput): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (step.text !== undefined) data["text"] = step.text;
	if (step.text_locale !== undefined) data["text_locale"] = step.text_locale;
	if (step.duration !== undefined) data["duration"] = step.duration;
	if (step.distance !== undefined) data["distance"] = step.distance;
	if (step.until_lap_press !== undefined) data["until_lap_press"] = step.until_lap_press;
	if (step.reps !== undefined) data["reps"] = step.reps;
	if (step.warmup !== undefined) data["warmup"] = step.warmup;
	if (step.cooldown !== undefined) data["cooldown"] = step.cooldown;
	if (step.intensity !== undefined) data["intensity"] = step.intensity;
	if (step.steps !== undefined) data["steps"] = step.steps.map(stepToDict);
	if (step.ramp !== undefined) data["ramp"] = step.ramp;
	if (step.freeride !== undefined) data["freeride"] = step.freeride;
	if (step.maxeffort !== undefined) data["maxeffort"] = step.maxeffort;
	if (step.power !== undefined) data["power"] = valueToDict(step.power);
	if (step.hr !== undefined) data["hr"] = valueToDict(step.hr);
	if (step.pace !== undefined) data["pace"] = valueToDict(step.pace);
	if (step.cadence !== undefined) data["cadence"] = valueToDict(step.cadence);
	if (step.hidepower !== undefined) data["hidepower"] = step.hidepower;
	return data;
}

function workoutDocToDict(doc: WorkoutDocInput): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (doc.description !== undefined) data["description"] = doc.description;
	if (doc.description_locale !== undefined) data["description_locale"] = doc.description_locale;
	if (doc.duration !== undefined) data["duration"] = doc.duration;
	if (doc.distance !== undefined) data["distance"] = doc.distance;
	if (doc.ftp !== undefined) data["ftp"] = doc.ftp;
	if (doc.lthr !== undefined) data["lthr"] = doc.lthr;
	if (doc.threshold_pace !== undefined) data["threshold_pace"] = doc.threshold_pace;
	if (doc.pace_units !== undefined) data["pace_units"] = doc.pace_units;
	if (doc.category !== undefined) data["category"] = doc.category;
	if (doc.target !== undefined) data["target"] = doc.target;
	if (doc.steps !== undefined) data["steps"] = doc.steps.map(stepToDict);
	if (doc.zone_times !== undefined) data["zoneTimes"] = doc.zone_times;
	if (doc.options !== undefined) data["options"] = doc.options;
	if (doc.locales !== undefined) data["locales"] = doc.locales;
	return data;
}

// ---------------------------------------------------------------------------
// Workout library helpers (ported from Python tools/workout_library.py)
// ---------------------------------------------------------------------------

const FOLDER_FIELDS = ["id", "name", "type", "num_workouts", "visibility", "description", "activity_types"];

const WORKOUT_COMPACT_FIELDS = ["id", "name", "type", "folder_id", "moving_time", "icu_training_load", "tags"];

const WORKOUT_FULL_EXTRA_FIELDS = ["description", "distance", "indoor", "color", "updated"];

function pickFields(record: Activity, fields: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of fields) {
		const value = record[key];
		if (value === null || value === undefined) continue;
		if (typeof value === "number" && value === 0 && key !== "folder_id") continue;
		if (typeof value === "string" && value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		result[key] = value;
	}
	return result;
}

function stripFolder(folder: Activity, requestingAthleteId: string): Record<string, unknown> {
	const result = pickFields(folder, FOLDER_FIELDS);
	if (requestingAthleteId) {
		const folderOwner = folder["athlete_id"];
		result["shared"] = folderOwner !== null && folderOwner !== undefined ? String(folderOwner) !== requestingAthleteId : false;
	}
	return result;
}

function findFolderChildren(folders: Activity[], targetId: number): Activity[] | null {
	for (const folder of folders) {
		if (!isRecord(folder)) continue;
		if (folder["id"] === targetId) {
			const children = folder["children"];
			if (Array.isArray(children)) return children.filter(isRecord);
			return [];
		}
		const nested = folder["children"];
		if (Array.isArray(nested)) {
			const subFolders = nested.filter((c): c is Activity => isRecord(c) && "children" in c);
			if (subFolders.length > 0) {
				const found = findFolderChildren(subFolders, targetId);
				if (found !== null) return found;
			}
		}
	}
	return null;
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
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (optional, defaults to 30 days ago)"),
			end_date: z.string().optional().describe("End date in YYYY-MM-DD format (optional, defaults to today)"),
			limit: z.number().int().positive().optional().describe("Maximum number of activities to return (optional, defaults to 10)"),
			include_unnamed: z.boolean().optional().describe("Whether to include unnamed activities (optional, defaults to false)"),
			compact: z
				.boolean()
				.optional()
				.describe("If true, return a brief one-line-per-activity summary to save tokens (optional, defaults to true)"),
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
			if (!Array.isArray(athleteResult) && typeof athleteResult["timezone"] === "string") {
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
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const activityData: Activity = Array.isArray(result) ? (result[0] as Activity) : (result as Activity);

			if (typeof activityData !== "object" || activityData === null) {
				return {
					content: [{ type: "text", text: `Invalid activity format for activity ${args.activity_id}.` }],
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
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			if (Array.isArray(result) || (!("icu_intervals" in result) && !("icu_groups" in result))) {
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
			histogram_type: z.enum(["power", "hr", "pace"]).describe('Type of histogram to retrieve. One of: "power", "hr", "pace"'),
			bucket_size: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Width of each bucket (optional). For power: watts (defaults to 10), for hr: bpm (defaults to 5). Not used for pace."),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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
					content: [{ type: "text", text: `Error fetching ${args.histogram_type} histogram: ${msg}` }],
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
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const types = args.stream_types || "time,watts,heartrate,cadence,altitude,distance,velocity_smooth";

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
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
		},
		async (args) => {
			const apiKey = args.api_key || env.API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: "API key is required. Set API_KEY secret or pass api_key." }],
				};
			}

			const result = await makeIntervalsRequest(apiKey, `/activity/${args.activity_id}/messages`, undefined, "POST", {
				content: args.content,
			});

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

	// ------------------------------------------------------------------
	// get_wellness_data
	// ------------------------------------------------------------------
	server.tool(
		"get_wellness_data",
		"Get wellness data for an athlete from Intervals.icu. By default returns standard wellness fields (training metrics, vitals, sleep, subjective scores, etc.). Set include_all_fields=True to also include any additional or custom fields configured by the user in Intervals.icu.",
		{
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (optional, defaults to 30 days ago)"),
			end_date: z.string().optional().describe("End date in YYYY-MM-DD format (optional, defaults to today)"),
			fields: z
				.array(z.string())
				.optional()
				.describe(
					'List of wellness sections to include (optional, defaults to all). Valid values: "training", "sport_info", "vital_signs", "sleep", "menstrual", "subjective", "nutrition", "activity".',
				),
			cadence: z
				.number()
				.int()
				.optional()
				.describe(
					"Return every Nth day of data (optional). For example, cadence=7 returns one entry per week. Use 0 (default) to return all entries without cadence filtering. Must be a positive integer when provided.",
				),
			include_all_fields: z
				.boolean()
				.optional()
				.describe("If True, include additional and custom fields beyond the standard set (optional, defaults to False)"),
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

			const [startDate, endDate] = resolveDateParams(args.start_date, args.end_date);

			let fieldsSet: Set<string> | undefined;
			if (args.fields && args.fields.length > 0) {
				const invalid = args.fields.filter((f) => !WELLNESS_FIELDS.has(f));
				if (invalid.length > 0) {
					const invalidSorted = [...new Set(invalid)].sort();
					const validSorted = [...WELLNESS_FIELDS].sort();
					return {
						content: [
							{
								type: "text",
								text: `Invalid field(s): ${invalidSorted.join(", ")}. Valid fields: ${validSorted.join(", ")}`,
							},
						],
					};
				}
				fieldsSet = new Set(args.fields);
			}

			const cadence = args.cadence ?? 0;
			if (cadence && cadence < 1) {
				return {
					content: [
						{
							type: "text",
							text: "Cadence must be a positive integer (1 or greater) when provided. Use 0 to disable cadence filtering.",
						},
					],
				};
			}

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/wellness`, {
				oldest: startDate,
				newest: endDate,
			});

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching wellness data: ${msg}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty) {
				return {
					content: [
						{
							type: "text",
							text: `No wellness data found for athlete ${athleteId} in the specified date range.`,
						},
					],
				};
			}

			let entries: Activity[] = [];
			if (!Array.isArray(result)) {
				for (const [dateStr, data] of Object.entries(result)) {
					if (isRecord(data)) {
						if (!("date" in data)) data["date"] = dateStr;
						entries.push(data);
					}
				}
			} else {
				entries = result.filter(isRecord);
			}

			if (cadence && cadence > 1) {
				entries = entries.filter((_, i) => i % cadence === 0);
			}

			let wellnessSummary = "Wellness Data:\n\n";
			for (const entry of entries) {
				wellnessSummary += formatWellnessEntry(entry, fieldsSet, args.include_all_fields ?? false) + "\n\n";
			}

			return { content: [{ type: "text", text: wellnessSummary }] };
		},
	);

	// ------------------------------------------------------------------
	// get_training_summary
	// ------------------------------------------------------------------
	server.tool(
		"get_training_summary",
		"Returns a compact JSON training snapshot for the given date range. Covers both past and future training. Past weeks include planned events alongside completed activity data with compliance. Future weeks show only planned events. Load metrics (CTL/ATL/TSB) are available for all weeks including projected values for future weeks. Intended as the first call in any coaching conversation to establish training context before making recommendations.",
		{
			start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (optional, defaults to 30 days ago)"),
			end_date: z.string().optional().describe("End date in YYYY-MM-DD format (optional, defaults to 30 days from now)"),
			athlete_id: z.string().optional().describe("Intervals.icu athlete ID (optional, falls back to ATHLETE_ID env var)"),
			api_key: z.string().optional().describe("Intervals.icu API key (optional, falls back to API_KEY env var)"),
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

			const startDate = args.start_date || daysAgoStr(30);
			const endDate = args.end_date || daysAheadStr(30);

			if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
				return {
					content: [{ type: "text", text: "Error: Invalid date format. Please use YYYY-MM-DD." }],
				};
			}

			const [summaryRaw, activitiesRaw, wellnessRaw, eventsRaw] = await Promise.all([
				makeIntervalsRequest(apiKey, `/athlete/${athleteId}/athlete-summary`, {
					start: startDate,
					end: endDate,
				}),
				makeIntervalsRequest(apiKey, `/athlete/${athleteId}/activities`, {
					oldest: startDate,
					newest: endDate,
				}),
				makeIntervalsRequest(apiKey, `/athlete/${athleteId}/wellness`, {
					oldest: startDate,
					newest: endDate,
				}),
				makeIntervalsRequest(apiKey, `/athlete/${athleteId}/events`, {
					oldest: startDate,
					newest: endDate,
				}),
			]);

			for (const [label, raw] of [
				["athlete-summary", summaryRaw],
				["activities", activitiesRaw],
				["wellness", wellnessRaw],
				["events", eventsRaw],
			] as const) {
				if (!Array.isArray(raw) && raw["error"]) {
					const msg = (raw["message"] as string) ?? "Unknown error";
					return { content: [{ type: "text", text: `Error fetching ${label}: ${msg}` }] };
				}
			}

			const summaryWeeks = Array.isArray(summaryRaw) ? (summaryRaw as Activity[]) : [];
			const activitiesList = Array.isArray(activitiesRaw) ? (activitiesRaw as Activity[]) : [];
			const wellnessList = Array.isArray(wellnessRaw) ? (wellnessRaw as Activity[]) : [];
			const eventsList = Array.isArray(eventsRaw) ? (eventsRaw as Activity[]) : [];

			summaryWeeks.sort((a, b) => String(a["date"] ?? "").localeCompare(String(b["date"] ?? "")));

			const today = new Date();
			const result = buildTrainingSummaryResult(summaryWeeks, activitiesList, wellnessList, eventsList, startDate, endDate, today);

			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		},
	);

	// ------------------------------------------------------------------
	// get_athlete_power_curves
	// ------------------------------------------------------------------
	server.tool(
		"get_athlete_power_curves",
		"Get power curves for an athlete from Intervals.icu. Returns best power output for selected durations across specified time periods. Uses FFT power computation. Power values are in watts.",
		{
			activity_type: z.string().describe('Activity type (e.g. "Ride", "Run", "VirtualRide")'),
			durations: z
				.array(z.number().int())
				.optional()
				.describe("Durations in seconds to include. Default is [5, 15, 30, 60, 120, 300, 600, 1200, 3600]"),
			indoor_outdoor: z.string().optional().describe('Filter by location — "indoor" or "outdoor". Omit for no filtering.'),
			start_date: z.string().optional().describe("Start date (YYYY-MM-DD) for custom date range curve. Must be used with end_date."),
			end_date: z.string().optional().describe("End date (YYYY-MM-DD) for custom date range curve. Must be used with start_date."),
			this_season: z.boolean().optional().describe("Include this season's curve (default True)"),
			last_season: z.boolean().optional().describe("Include last season's curve (default True)"),
			include_normalised: z.boolean().optional().describe("Include weight-normalised W/kg values (default True)"),
			athlete_id: z.string().optional().describe("Intervals.icu athlete ID (optional, uses ATHLETE_ID from env if not provided)"),
		},
		async (args) => {
			const apiKey = env.API_KEY;
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

			const activityType = resolveActivityType(args.activity_type);
			const durations = args.durations ?? DEFAULT_DURATIONS;
			const indoorOutdoor = args.indoor_outdoor;

			if (indoorOutdoor && indoorOutdoor !== "indoor" && indoorOutdoor !== "outdoor") {
				return {
					content: [{ type: "text", text: "Error: indoor_outdoor must be 'indoor', 'outdoor', or omitted." }],
				};
			}

			const dateError = validatePowerCurveDates(args.start_date, args.end_date);
			if (dateError) {
				return { content: [{ type: "text", text: dateError }] };
			}

			const thisSeason = args.this_season ?? true;
			const lastSeason = args.last_season ?? true;
			const includeNormalised = args.include_normalised ?? true;

			const curves = buildCurvesParam(thisSeason, lastSeason, args.start_date, args.end_date);
			if (!curves.length) {
				return {
					content: [
						{
							type: "text",
							text: "Error: At least one curve must be selected (this_season, last_season, or a date range).",
						},
					],
				};
			}

			const params: Record<string, ParamValue> = {
				curves,
				type: activityType,
				includeRanks: false,
			};
			if (indoorOutdoor) {
				params["filters"] = JSON.stringify([{ field_id: "indoor", value: indoorOutdoor, id: 1 }]);
			}

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/power-curves`, params);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching power curves: ${msg}` }] };
			}

			let curveList: Activity[] = [];
			if (Array.isArray(result)) {
				curveList = result.filter(isRecord);
			} else if (Array.isArray(result["list"])) {
				curveList = (result["list"] as unknown[]).filter(isRecord);
			}

			if (!curveList.length) {
				return {
					content: [{ type: "text", text: `No power curve data found for athlete ${athleteId} (${activityType}).` }],
				};
			}

			const extracted = curveList.map((curve) => extractCurveData(curve, durations, includeNormalised));

			return { content: [{ type: "text", text: formatPowerCurves(extracted, activityType, includeNormalised) }] };
		},
	);

	// ------------------------------------------------------------------
	// get_athlete_zones
	// ------------------------------------------------------------------
	server.tool(
		"get_athlete_zones",
		"Get training zone definitions for an athlete from Intervals.icu. Returns power zones, heart rate zones, and pace zones per sport, along with the thresholds they are derived from (FTP, LTHR, threshold pace). Useful for interpreting zone-relative metrics in activity data or for prescribing intensity targets in planned workouts.",
		{
			athlete_id: z.string().optional().describe("Intervals.icu athlete ID (optional, falls back to ATHLETE_ID env var)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			sport: z
				.string()
				.optional()
				.describe('Filter to a specific sport type e.g. "Run", "Ride", "Swim" (optional, returns all if omitted)'),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/sport-settings`);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching athlete zones: ${msg}` }] };
			}

			if (!result || !Array.isArray(result) || result.length === 0) {
				return { content: [{ type: "text", text: `No sport settings found for athlete ${athleteId}.` }] };
			}

			let zonesList = result.filter(isRecord).map((setting) => extractSportZones(setting));

			if (args.sport) {
				const sport = args.sport;
				zonesList = zonesList.filter((z) => (z["types"] as string[]).includes(sport));
				if (!zonesList.length) {
					return { content: [{ type: "text", text: `No zone settings found for sport '${sport}'.` }] };
				}
			}

			if (!zonesList.length) {
				return { content: [{ type: "text", text: `No zone settings found for athlete ${athleteId}.` }] };
			}

			return { content: [{ type: "text", text: JSON.stringify(zonesList) }] };
		},
	);

	// ------------------------------------------------------------------
	// get_events
	// ------------------------------------------------------------------
	server.tool(
		"get_events",
		"Get events for an athlete from Intervals.icu",
		{
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (optional, defaults to today)"),
			end_date: z.string().optional().describe("End date in YYYY-MM-DD format (optional, defaults to 30 days from today)"),
			compact: z
				.boolean()
				.optional()
				.describe("If True, return a brief one-line-per-event summary to save tokens (optional, defaults to True)"),
			category: z
				.string()
				.optional()
				.describe(
					'Filter events by category. Comma-separated list of categories to include (e.g. "NOTE", "HOLIDAY,RACE_A", "WORKOUT,NOTE"). Valid categories: WORKOUT, RACE_A, RACE_B, RACE_C, NOTE, PLAN, HOLIDAY, SICK, INJURED, SET_EFTP, FITNESS_DAYS, SEASON_START, TARGET, SET_FITNESS. Returns an error if an invalid category is provided. If not provided, all events are returned.',
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

			const startDate = args.start_date || todayStr();
			const endDate = args.end_date || daysAheadStr(30);

			let categoryFilter: string | undefined;
			if (args.category) {
				const parsed = new Set(
					args.category
						.split(",")
						.map((c) => c.trim().toUpperCase())
						.filter((c) => c.length > 0),
				);
				const invalid = [...parsed].filter((c) => !VALID_EVENT_CATEGORIES.has(c));
				if (invalid.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Invalid event category: ${[...new Set(invalid)].sort().join(", ")}. Valid categories are: ${[...VALID_EVENT_CATEGORIES].sort().join(", ")}.`,
							},
						],
					};
				}
				categoryFilter = [...parsed].sort().join(",");
			}

			const params: Record<string, ParamValue> = { oldest: startDate, newest: endDate };
			if (categoryFilter) params["category"] = categoryFilter;

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/events`, params);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching events: ${msg}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty) {
				return {
					content: [{ type: "text", text: `No events found for athlete ${athleteId} in the specified date range.` }],
				};
			}

			const events = Array.isArray(result) ? result.filter(isRecord) : [];
			if (!events.length) {
				return {
					content: [{ type: "text", text: `No events found for athlete ${athleteId} in the specified date range.` }],
				};
			}

			const compact = args.compact ?? true;
			const formatter = compact ? formatEventCompact : formatEventSummary;
			let eventsSummary = "Events:\n\n";
			for (const event of events) {
				eventsSummary += formatter(event) + "\n";
			}

			return { content: [{ type: "text", text: eventsSummary }] };
		},
	);

	// ------------------------------------------------------------------
	// get_event_by_id
	// ------------------------------------------------------------------
	server.tool(
		"get_event_by_id",
		"Get detailed information for a specific event from Intervals.icu",
		{
			event_id: z.string().describe("The Intervals.icu event ID"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/events/${args.event_id}`);

			if (!Array.isArray(result) && result["error"]) {
				const msg = (result["message"] as string) ?? "Unknown error";
				return { content: [{ type: "text", text: `Error fetching event details: ${msg}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty) {
				return { content: [{ type: "text", text: `No details found for event ${args.event_id}.` }] };
			}

			if (Array.isArray(result)) {
				return { content: [{ type: "text", text: `Invalid event format for event ${args.event_id}.` }] };
			}

			return { content: [{ type: "text", text: formatEventDetails(result) }] };
		},
	);

	// ------------------------------------------------------------------
	// delete_event
	// ------------------------------------------------------------------
	server.tool(
		"delete_event",
		"Delete event for an athlete from Intervals.icu",
		{
			event_id: z.string().describe("The Intervals.icu event ID"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			if (!args.event_id) {
				return { content: [{ type: "text", text: "Error: No event ID provided." }] };
			}

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/events/${args.event_id}`, undefined, "DELETE");

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error deleting event: ${result["message"]}` }] };
			}

			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		},
	);

	// ------------------------------------------------------------------
	// delete_events_by_date_range
	// ------------------------------------------------------------------
	server.tool(
		"delete_events_by_date_range",
		"Delete events for an athlete from Intervals.icu in the specified date range.",
		{
			start_date: z.string().describe("Start date in YYYY-MM-DD format"),
			end_date: z.string().describe("End date in YYYY-MM-DD format"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const [events, fetchErrorMsg] = await fetchEventsForDeletion(apiKey, athleteId, args.start_date, args.end_date);
			if (fetchErrorMsg) {
				return { content: [{ type: "text", text: fetchErrorMsg }] };
			}

			const failedEvents = await deleteEventsList(apiKey, athleteId, events);
			const deletedCount = events.length - failedEvents.length;

			return {
				content: [
					{
						type: "text",
						text: `Deleted ${deletedCount} events. Failed to delete ${failedEvents.length} events: ${JSON.stringify(failedEvents)}`,
					},
				],
			};
		},
	);

	// ------------------------------------------------------------------
	// add_or_update_event
	// ------------------------------------------------------------------
	server.tool(
		"add_or_update_event",
		'Post event for an athlete to Intervals.icu this follows the event api from intervals.icu. If event_id is provided, the event will be updated instead of created.\n\nExample workout_doc:\n{\n  "description": "High-intensity workout for increasing VO2 max",\n  "steps": [\n    {"power": {"value": 80, "units": "%ftp"}, "duration": 900, "warmup": true},\n    {"reps": 2, "text": "High-intensity intervals", "steps": [\n      {"power": {"value": 110, "units": "%ftp"}, "distance": 500, "text": "High-intensity"},\n      {"power": {"value": 80, "units": "%ftp"}, "duration": 90, "text": "Recovery"}\n    ]},\n    {"power": {"value": 80, "units": "%ftp"}, "duration": 600, "cooldown": true},\n    {"text": ""}\n  ]\n}\n\nStep properties:\n- distance: Distance of step in meters\n- duration: Duration of step in seconds\n- power/hr/pace/cadence: Define step intensity (e.g. {"power": {"value": 80, "units": "%ftp"}}, {"power": {"value": 200, "units": "w"}}, {"hr": {"value": 85, "units": "%lthr"}}, {"cadence": {"value": 90, "units": "cadence"}}, {"pace": {"value": 2, "units": "pace_zone"}})\n- Ranges: {"power": {"start": 80, "end": 90, "units": "%ftp"}}\n- Ramps: {"ramp": true, "power": {"start": 80, "end": 90, "units": "%ftp"}}\n- Repeats: {"reps": 3, "steps": [...]}\n- Free Ride: {"freeride": true, "power": {"value": 80, "units": "%ftp"}}\n- Comments/labels: {"text": "Warmup"}',
		{
			workout_type: z.string().describe("Workout type (e.g. Ride, Run, Swim, Walk, Row)"),
			name: z.string().describe("Name of the activity"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			event_id: z.string().optional().describe("The Intervals.icu event ID (optional; if provided the event is updated)"),
			start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (optional, defaults to today)"),
			workout_doc: WorkoutDocSchema.optional().describe(
				"Steps as a list of Step objects (optional, but necessary to define workout steps)",
			),
			moving_time: z
				.number()
				.int()
				.optional()
				.describe(
					"Total expected moving time of the workout in seconds (optional). Use 0 (default) to omit from the request; 0 will not be transmitted to the API.",
				),
			distance: z
				.number()
				.int()
				.optional()
				.describe(
					"Total expected distance of the workout in meters (optional). Use 0 (default) to omit from the request; 0 will not be transmitted to the API.",
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

			const startDate = args.start_date || todayStr();
			const movingTime = args.moving_time ?? 0;
			const distance = args.distance ?? 0;

			try {
				const eventData = prepareEventData(
					args.name,
					args.workout_type,
					startDate,
					args.workout_doc as WorkoutDocInput | undefined,
					movingTime || null,
					distance || null,
				);
				const text = await createOrUpdateEventRequest(apiKey, athleteId, eventData, startDate, args.event_id);
				return { content: [{ type: "text", text }] };
			} catch (e) {
				return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
			}
		},
	);

	// ------------------------------------------------------------------
	// get_custom_items
	// ------------------------------------------------------------------
	server.tool(
		"get_custom_items",
		"Get custom items (charts, custom fields, zones, etc.) for an athlete from Intervals.icu",
		{
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/custom-item`);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error fetching custom items: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty) {
				return { content: [{ type: "text", text: `No custom items found for athlete ${athleteId}.` }] };
			}

			let output = "Custom Items:\n\n";
			if (Array.isArray(result)) {
				for (const item of result) {
					if (isRecord(item)) {
						output += `- ID: ${item["id"]}\n`;
						output += `  Name: ${item["name"] ?? "N/A"}\n`;
						output += `  Type: ${item["type"] ?? "N/A"}\n`;
						if (item["description"]) output += `  Description: ${item["description"]}\n`;
						output += "\n";
					}
				}
			}

			return { content: [{ type: "text", text: output }] };
		},
	);

	// ------------------------------------------------------------------
	// get_custom_item_by_id
	// ------------------------------------------------------------------
	server.tool(
		"get_custom_item_by_id",
		"Get detailed information for a specific custom item from Intervals.icu",
		{
			item_id: z.number().int().describe("The custom item ID"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/custom-item/${args.item_id}`);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error fetching custom item: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty || Array.isArray(result)) {
				return { content: [{ type: "text", text: `No custom item found with ID ${args.item_id}.` }] };
			}

			return { content: [{ type: "text", text: formatCustomItemDetails(result) }] };
		},
	);

	// ------------------------------------------------------------------
	// create_custom_item
	// ------------------------------------------------------------------
	server.tool(
		"create_custom_item",
		"Create a new custom item for an athlete on Intervals.icu",
		{
			name: z.string().describe("Name of the custom item"),
			item_type: z
				.string()
				.describe(
					"Type of custom item (e.g. FITNESS_CHART, TRACE_CHART, INPUT_FIELD, ACTIVITY_FIELD, INTERVAL_FIELD, ACTIVITY_STREAM, ACTIVITY_CHART, ACTIVITY_HISTOGRAM, ACTIVITY_HEATMAP, ACTIVITY_MAP, ACTIVITY_PANEL, ZONES)",
				),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			description: z.string().optional().describe("Description of the custom item (optional)"),
			content: z
				.union([z.record(z.string(), z.unknown()), z.string()])
				.optional()
				.describe(
					'Configuration content for the custom item as a dict (optional). Important enum values: "type" field for INPUT_FIELD/ACTIVITY_FIELD must be "numeric", "text", or "select" (NOT "number"); "aggregate" field must be "MIN", "SUM", "MAX", or "AVERAGE" (NOT "AVG")',
				),
			visibility: z.string().optional().describe("Visibility setting: PRIVATE, FOLLOWERS, or PUBLIC (optional)"),
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

			const data: Record<string, unknown> = { name: args.name, type: args.item_type };
			if (args.description) data["description"] = args.description;
			if (args.content !== undefined) {
				let content: unknown = args.content;
				if (typeof content === "string") {
					try {
						content = JSON.parse(content);
					} catch {
						return {
							content: [{ type: "text", text: "Error: content must be valid JSON when passed as a string." }],
						};
					}
				}
				data["content"] = content;
			}
			if (args.visibility) data["visibility"] = args.visibility;

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/custom-item`, undefined, "POST", data);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error creating custom item: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty || Array.isArray(result)) {
				return { content: [{ type: "text", text: "Error: Unexpected response when creating custom item." }] };
			}

			return {
				content: [{ type: "text", text: `Successfully created custom item:\n\n${formatCustomItemDetails(result)}` }],
			};
		},
	);

	// ------------------------------------------------------------------
	// update_custom_item
	// ------------------------------------------------------------------
	server.tool(
		"update_custom_item",
		"Update an existing custom item for an athlete on Intervals.icu",
		{
			item_id: z.number().int().describe("The custom item ID to update"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			name: z.string().optional().describe("New name for the custom item (optional)"),
			item_type: z.string().optional().describe("New type for the custom item (optional)"),
			description: z.string().optional().describe("New description for the custom item (optional)"),
			content: z
				.union([z.record(z.string(), z.unknown()), z.string()])
				.optional()
				.describe(
					'New configuration content for the custom item as a dict (optional). Important enum values: "type" field for INPUT_FIELD/ACTIVITY_FIELD must be "numeric", "text", or "select" (NOT "number"); "aggregate" field must be "MIN", "SUM", "MAX", or "AVERAGE" (NOT "AVG")',
				),
			visibility: z.string().optional().describe("New visibility setting: PRIVATE, FOLLOWERS, or PUBLIC (optional)"),
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

			const data: Record<string, unknown> = {};
			if (args.name) data["name"] = args.name;
			if (args.item_type) data["type"] = args.item_type;
			if (args.description) data["description"] = args.description;
			if (args.content !== undefined) {
				let content: unknown = args.content;
				if (typeof content === "string") {
					try {
						content = JSON.parse(content);
					} catch {
						return {
							content: [{ type: "text", text: "Error: content must be valid JSON when passed as a string." }],
						};
					}
				}
				data["content"] = content;
			}
			if (args.visibility) data["visibility"] = args.visibility;

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/custom-item/${args.item_id}`, undefined, "PUT", data);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error updating custom item: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty || Array.isArray(result)) {
				return { content: [{ type: "text", text: "Error: Unexpected response when updating custom item." }] };
			}

			return {
				content: [{ type: "text", text: `Successfully updated custom item:\n\n${formatCustomItemDetails(result)}` }],
			};
		},
	);

	// ------------------------------------------------------------------
	// delete_custom_item
	// ------------------------------------------------------------------
	server.tool(
		"delete_custom_item",
		"Delete a custom item for an athlete from Intervals.icu",
		{
			item_id: z.number().int().describe("The custom item ID to delete"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/custom-item/${args.item_id}`, undefined, "DELETE");

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error deleting custom item: ${result["message"]}` }] };
			}

			return { content: [{ type: "text", text: `Successfully deleted custom item ${args.item_id}.` }] };
		},
	);

	// ------------------------------------------------------------------
	// get_workout_folders
	// ------------------------------------------------------------------
	server.tool(
		"get_workout_folders",
		"Get workout library folders for an athlete from Intervals.icu. Returns folder/plan metadata (id, name, type, num_workouts, visibility, description, activity_types). The children field is always stripped — use list_workouts(folder_id=...) to browse workouts inside a folder. This is typically the first call an agent should make when exploring the workout library.",
		{
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/folders`);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error fetching workout folders: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty) {
				return { content: [{ type: "text", text: `No workout folders found for athlete ${athleteId}.` }] };
			}

			let folders: Record<string, unknown>[];
			if (Array.isArray(result)) {
				folders = result.filter(isRecord).map((f) => stripFolder(f, athleteId));
			} else if (isRecord(result)) {
				folders = [stripFolder(result, athleteId)];
			} else {
				return { content: [{ type: "text", text: "Unexpected response format from folders endpoint." }] };
			}

			if (!folders.length) {
				return { content: [{ type: "text", text: `No workout folders found for athlete ${athleteId}.` }] };
			}

			return { content: [{ type: "text", text: JSON.stringify(folders) }] };
		},
	);

	// ------------------------------------------------------------------
	// list_workouts
	// ------------------------------------------------------------------
	server.tool(
		"list_workouts",
		"List workouts in the athlete's workout library on Intervals.icu. Use get_workout_folders first to discover folder IDs, then pass a folder_id to filter results to a specific folder. Supports both the athlete's own workouts and shared workouts. When a folder_id is provided, the tool also queries the folders endpoint so that workouts inside shared folders/plans are included. workout_doc (step-by-step structure) is never included in list output. Use get_workout(workout_id) to expand a specific workout.",
		{
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			folder_id: z
				.number()
				.int()
				.optional()
				.describe("Filter to workouts in this folder only (optional). Works for both own and shared folders."),
			compact: z
				.boolean()
				.optional()
				.describe(
					"If True (default), return a brief summary per workout to save tokens. Full mode adds description, distance, indoor, color, and updated fields.",
				),
			workout_type: z.string().optional().describe('Filter by activity type, e.g. "Ride", "Run", "Swim" (optional, case-insensitive).'),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/workouts`);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error fetching workouts: ${result["message"]}` }] };
			}

			const ownWorkouts: Activity[] = Array.isArray(result) ? result.filter(isRecord) : [];

			let workouts: Activity[] = [];
			let shared = false;

			const folderId = args.folder_id;
			if (folderId !== undefined) {
				workouts = ownWorkouts.filter((w) => w["folder_id"] === folderId);

				if (workouts.length === 0) {
					const foldersResult = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/folders`);
					if (Array.isArray(foldersResult)) {
						const children = findFolderChildren(foldersResult.filter(isRecord), folderId);
						if (children !== null) {
							workouts = children;
							shared = true;
						}
					}
				}
			} else {
				workouts = ownWorkouts;
			}

			if (args.workout_type) {
				const typeLower = args.workout_type.toLowerCase();
				workouts = workouts.filter((w) => String(w["type"] ?? "").toLowerCase() === typeLower);
			}

			if (!workouts.length) {
				let msg = `No workouts found for athlete ${athleteId}`;
				if (folderId !== undefined) msg += ` in folder ${folderId}`;
				if (args.workout_type) msg += ` with type '${args.workout_type}'`;
				return { content: [{ type: "text", text: msg + "." }] };
			}

			const fields = [...WORKOUT_COMPACT_FIELDS];
			if (!(args.compact ?? true)) fields.push(...WORKOUT_FULL_EXTRA_FIELDS);

			const output = workouts.map((w) => pickFields(w, fields));

			if (shared) {
				return { content: [{ type: "text", text: JSON.stringify({ shared: true, workouts: output }) }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(output) }] };
		},
	);

	// ------------------------------------------------------------------
	// get_workout
	// ------------------------------------------------------------------
	server.tool(
		"get_workout",
		"Get full detail for a single workout from the Intervals.icu library, including workout_doc steps. Use list_workouts to discover workout IDs first.",
		{
			workout_id: z.number().int().describe("The workout ID to retrieve"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
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

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/workouts/${args.workout_id}`);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error fetching workout: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty || Array.isArray(result)) {
				return { content: [{ type: "text", text: `No workout found with ID ${args.workout_id}.` }] };
			}

			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		},
	);

	// ------------------------------------------------------------------
	// create_workout
	// ------------------------------------------------------------------
	server.tool(
		"create_workout",
		"Create a new workout in the Intervals.icu workout library. Use get_workout_folders to find the target folder_id before calling this tool.",
		{
			name: z.string().describe("Workout name (required)"),
			workout_type: z.string().describe('Activity type, e.g. "Ride", "Run", "Swim" (required)'),
			folder_id: z.number().int().describe("Target library folder ID (required). Use get_workout_folders to discover IDs."),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			description: z.string().optional().describe("Workout description (optional)"),
			workout_doc: WorkoutDocSchema.optional().describe(
				"Structured step definition (optional). Same format as used by add_or_update_event.",
			),
			moving_time: z.number().int().optional().describe("Expected total duration in seconds (optional)"),
			tags: z.array(z.string()).optional().describe("List of tag strings (optional)"),
			indoor: z.boolean().optional().describe("Whether this is an indoor workout (optional)"),
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

			const data: Record<string, unknown> = { name: args.name, type: args.workout_type, folder_id: args.folder_id };
			if (args.description) data["description"] = args.description;
			if (args.workout_doc !== undefined) data["workout_doc"] = workoutDocToDict(args.workout_doc as WorkoutDocInput);
			if (args.moving_time) data["moving_time"] = args.moving_time;
			if (args.tags && args.tags.length > 0) data["tags"] = args.tags;
			if (args.indoor !== undefined) data["indoor"] = args.indoor;

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/workouts`, undefined, "POST", data);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error creating workout: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty || Array.isArray(result)) {
				return { content: [{ type: "text", text: "Error: Unexpected response when creating workout." }] };
			}

			return {
				content: [{ type: "text", text: `Successfully created workout:\n\n${JSON.stringify(result)}` }],
			};
		},
	);

	// ------------------------------------------------------------------
	// update_workout
	// ------------------------------------------------------------------
	server.tool(
		"update_workout",
		"Update an existing workout in the Intervals.icu workout library. Only provided fields are sent — omit fields you do not want to change. Pass folder_id to move the workout to a different folder. Use list_workouts or get_workout to find the workout_id first.",
		{
			workout_id: z.number().int().describe("The workout ID to update (required)"),
			athlete_id: z.string().optional().describe("The Intervals.icu athlete ID (optional, will use ATHLETE_ID from env if not provided)"),
			api_key: z.string().optional().describe("The Intervals.icu API key (optional, will use API_KEY from env if not provided)"),
			name: z.string().optional().describe("New workout name (optional)"),
			description: z.string().optional().describe("New workout description (optional)"),
			folder_id: z.number().int().optional().describe("Move workout to this folder (optional). Use get_workout_folders to discover IDs."),
			workout_doc: WorkoutDocSchema.optional().describe("New structured step definition (optional)"),
			tags: z.array(z.string()).optional().describe("New list of tag strings (optional)"),
			moving_time: z.number().int().optional().describe("New expected duration in seconds (optional)"),
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

			const data: Record<string, unknown> = {};
			if (args.name) data["name"] = args.name;
			if (args.description) data["description"] = args.description;
			if (args.folder_id !== undefined) data["folder_id"] = args.folder_id;
			if (args.workout_doc !== undefined) data["workout_doc"] = workoutDocToDict(args.workout_doc as WorkoutDocInput);
			if (args.tags !== undefined) data["tags"] = args.tags;
			if (args.moving_time) data["moving_time"] = args.moving_time;

			const result = await makeIntervalsRequest(apiKey, `/athlete/${athleteId}/workouts/${args.workout_id}`, undefined, "PUT", data);

			if (!Array.isArray(result) && result["error"]) {
				return { content: [{ type: "text", text: `Error updating workout: ${result["message"]}` }] };
			}

			const isEmpty = Array.isArray(result) ? result.length === 0 : Object.keys(result).length === 0;
			if (!result || isEmpty || Array.isArray(result)) {
				return { content: [{ type: "text", text: "Error: Unexpected response when updating workout." }] };
			}

			return {
				content: [{ type: "text", text: `Successfully updated workout:\n\n${JSON.stringify(result)}` }],
			};
		},
	);

	return server;
}

// ---------------------------------------------------------------------------
// Cloudflare Worker export
// ---------------------------------------------------------------------------

// Constant-time string comparison to avoid leaking secret bytes via response
// timing. Both inputs are hashed to a fixed length first so comparison time
// doesn't vary with the length of the (attacker-controlled) provided secret.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [aDigest, bDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	const aBytes = new Uint8Array(aDigest);
	const bBytes = new Uint8Array(bDigest);
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
	return diff === 0;
}

async function checkSharedSecret(request: Request, env: WorkerEnv): Promise<Response | null> {
	if (!env.MCP_SHARED_SECRET) {
		return new Response("Server misconfigured: MCP_SHARED_SECRET is not set.", { status: 500 });
	}

	const authHeader = request.headers.get("Authorization") ?? "";
	const providedSecret = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

	if (!providedSecret || !(await timingSafeEqual(providedSecret, env.MCP_SHARED_SECRET))) {
		return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
	}

	return null;
}

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		const authError = await checkSharedSecret(request, env);
		if (authError) return authError;

		// This server never emits server-initiated notifications, so the
		// standalone GET SSE stream would sit open indefinitely with no
		// bytes flowing. Cloudflare's runtime treats a request that produces
		// no output for ~30s as hung and kills it, so we don't serve GET.
		if (request.method === "GET") {
			return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
		}

		const server = createServer(env);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	},
} satisfies ExportedHandler<WorkerEnv>;
