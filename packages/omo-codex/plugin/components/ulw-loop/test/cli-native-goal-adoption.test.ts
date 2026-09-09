import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulwLoopCommand } from "../src/cli-commands.js";
import { adoptNativeGoal } from "../src/native-goal-adoption.js";
import { ulwLoopBriefPath, ulwLoopGoalsPath, ulwLoopLedgerPath } from "../src/paths.js";
import { readUlwLoopPlan, writePlan } from "../src/plan-io.js";
import {
	ADOPTION_BRIEF,
	ADOPTION_LEDGER,
	ADOPTION_SCOPE,
	adoptionPlan,
	NATIVE_OBJECTIVE,
	nativeSnapshot,
} from "./fixtures/native-goal-adoption.js";

let repo: string;
let output: string;

beforeEach(async () => {
	for (const key of ["OMO_ULW_LOOP_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"])
		vi.stubEnv(key, undefined);
	repo = await mkdtemp(join(tmpdir(), "ulw-native-adoption-"));
	await writePlan(repo, adoptionPlan(), ADOPTION_SCOPE);
	await writeFile(ulwLoopBriefPath(repo, ADOPTION_SCOPE), ADOPTION_BRIEF);
	await writeFile(ulwLoopLedgerPath(repo, ADOPTION_SCOPE), ADOPTION_LEDGER);
	vi.spyOn(process, "cwd").mockReturnValue(repo);
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output += chunk.toString();
		return true;
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(repo, { recursive: true, force: true });
});

function adoptionArgs(snapshot: unknown = nativeSnapshot()): string[] {
	return [
		"adopt-native-goal",
		"--session-id",
		ADOPTION_SCOPE.sessionId,
		"--goal-id",
		"G002",
		"--expected-objective",
		adoptionPlan().codexObjective ?? "",
		"--codex-goal-json",
		JSON.stringify(snapshot),
		"--evidence",
		"user authorized unchanged native objective binding",
		"--rationale",
		"repair binding only; preserve all completion gates",
		"--json",
	];
}

async function run(args: string[]) {
	output = "";
	const code = await ulwLoopCommand(args);
	return { code, result: JSON.parse(output) };
}

async function adopt(snapshot: unknown = nativeSnapshot(), extra: string[] = []) {
	return run([...adoptionArgs(snapshot), ...extra]);
}

async function stateBytes() {
	return Promise.all(
		[ulwLoopGoalsPath, ulwLoopBriefPath, ulwLoopLedgerPath].map((path) =>
			readFile(path(repo, ADOPTION_SCOPE), "utf8"),
		),
	);
}

async function expectRejected(args: string[], code: string) {
	const before = await stateBytes();
	expect(await run(args)).toMatchObject({ code: 1, result: { ok: false, error: { code } } });
	expect(await stateBytes()).toEqual(before);
}

describe("#given the isolated blocked G002 shape", () => {
	it("#when explicitly adopted through the CLI #then only compatibility and audit metadata change", async () => {
		const before = await readUlwLoopPlan(repo, ADOPTION_SCOPE);
		const snapshot = nativeSnapshot();
		const { code, result } = await adopt(snapshot);
		expect(code).toBe(0);
		expect(result).toMatchObject({ ok: true, adopted: true });
		const after = await readUlwLoopPlan(repo, ADOPTION_SCOPE);
		expect(after).toEqual({
			...before,
			updatedAt: after.updatedAt,
			codexObjectiveAliases: [NATIVE_OBJECTIVE],
			nativeGoalBinding: ADOPTION_SCOPE,
		});
		expect(await readFile(ulwLoopBriefPath(repo, ADOPTION_SCOPE), "utf8")).toBe(ADOPTION_BRIEF);
		const ledger = await readFile(ulwLoopLedgerPath(repo, ADOPTION_SCOPE), "utf8");
		expect(ledger.startsWith(ADOPTION_LEDGER)).toBe(true);
		const entries = ledger
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(entries).toHaveLength(2);
		expect(entries[1]).toMatchObject({
			kind: "native_goal_adopted",
			goalId: "G002",
			codexGoal: snapshot,
			evidence: "user authorized unchanged native objective binding",
			message: "repair binding only; preserve all completion gates",
			before: { nativeGoalBinding: null, codexObjectiveAliases: [] },
			after: { nativeGoalBinding: ADOPTION_SCOPE, codexObjectiveAliases: [NATIVE_OBJECTIVE] },
		});
		const bytes = await readFile(ulwLoopGoalsPath(repo, ADOPTION_SCOPE), "utf8");
		expect(await adopt(snapshot)).toMatchObject({ code: 0, result: { adopted: false } });
		expect(await readFile(ulwLoopGoalsPath(repo, ADOPTION_SCOPE), "utf8")).toBe(bytes);
		expect(await readFile(ulwLoopLedgerPath(repo, ADOPTION_SCOPE), "utf8")).toBe(ledger);
	});

	it.each(["canonical", "alias"])(
		"#when first adopting an already-compatible %s #then persists audited binding metadata once without changing aliases",
		async (kind) => {
			const seed = adoptionPlan();
			if (kind === "alias") seed.codexObjectiveAliases = [NATIVE_OBJECTIVE];
			await writePlan(repo, seed, ADOPTION_SCOPE);
			const snapshot = nativeSnapshot("ACTIVE", kind === "alias" ? NATIVE_OBJECTIVE : seed.codexObjective);
			expect(await adopt(snapshot)).toMatchObject({ code: 0, result: { adopted: true } });
			const after = await readUlwLoopPlan(repo, ADOPTION_SCOPE);
			expect(after).toEqual({ ...seed, updatedAt: after.updatedAt, nativeGoalBinding: ADOPTION_SCOPE });
			const bytes = await stateBytes();
			const entries = (bytes[2] ?? "")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(entries).toHaveLength(2);
			expect(entries[1]).toMatchObject({
				kind: "native_goal_adopted",
				before: { nativeGoalBinding: null },
				after: { nativeGoalBinding: ADOPTION_SCOPE },
			});
			expect(await adopt(snapshot)).toMatchObject({ code: 0, result: { adopted: false } });
			expect(await stateBytes()).toEqual(bytes);
		},
	);

	it.each(["ACTIVE", "active", "blocked"])("#when binding %s #then it never advances the loop", async (status) => {
		expect(await adopt(nativeSnapshot(status))).toMatchObject({ code: 0, result: { adopted: true } });
		expect((await readUlwLoopPlan(repo, ADOPTION_SCOPE)).goals).toEqual(adoptionPlan().goals);
	});

	it.each(["COMPLETE", "completed", "FAILED", "CANCELLED", "PAUSED", "pending", "running", "unknown", ""])(
		"#when native status is %s #then rejects without mutation",
		async (status) => {
			await expectRejected(adoptionArgs(nativeSnapshot(status)), "ULW_LOOP_ADOPTION_STATUS_UNSUPPORTED");
		},
	);

	it.each([
		null,
		{},
		[],
		{ goal: null },
		{ goal: false },
		{ goal: {} },
		{ goal: { status: "ACTIVE" } },
		{ goal: { objective: "  ", status: "ACTIVE" } },
		{ goal: { title: "not an objective", status: "ACTIVE" } },
		{ goal: { objective: 123, status: "ACTIVE" } },
	])("#when snapshot is malformed or empty %j #then rejects without mutation", async (snapshot) => {
		await expectRejected(adoptionArgs(snapshot), "ULW_LOOP_ADOPTION_SNAPSHOT_INVALID");
	});

	it.each(["threadId", "thread_id", "sessionId", "session_id"])(
		"#when snapshot %s conflicts at either level #then rejects even if the other id matches",
		async (key) => {
			for (const snapshot of [
				{ ...nativeSnapshot(), [key]: "other-session" },
				{ ...nativeSnapshot(), goal: { ...nativeSnapshot().goal, [key]: "other-session" } },
				{ ...nativeSnapshot(), [key]: null },
			])
				await expectRejected(adoptionArgs(snapshot), "ULW_LOOP_ADOPTION_SCOPE_MISMATCH");
		},
	);

	it.each(["--evidence", "--rationale", "--expected-objective", "--codex-goal-json", "--goal-id"])(
		"#when %s is empty #then rejects without mutation",
		async (flag) => {
			const args = adoptionArgs();
			args[args.indexOf(flag) + 1] = " ";
			await expectRejected(args, "ULW_LOOP_ARGUMENT_MISSING");
		},
	);

	it.each([
		["--expected-objective", "stale objective", "ULW_LOOP_ADOPTION_OBJECTIVE_MISMATCH"],
		["--goal-id", "G003", "ULW_LOOP_ADOPTION_GOAL_STATUS_UNSUPPORTED"],
		["--goal-id", "G001", "ULW_LOOP_ADOPTION_GOAL_STATUS_UNSUPPORTED"],
		["--goal-id", "absent", "ULW_LOOP_ADOPTION_GOAL_NOT_FOUND"],
		["--codex-goal-json", "{broken", "ULW_LOOP_ADOPTION_SNAPSHOT_INVALID"],
		["--session-id", "../isolated-native-adoption", "ULW_LOOP_ADOPTION_SCOPE_REQUIRED"],
	])("#when %s is %s #then rejects without mutation", async (flag, value, code) => {
		const args = adoptionArgs();
		args[args.indexOf(flag) + 1] = value;
		await expectRejected(args, code);
	});

	it("#when scope is absent or selects a sibling #then neither plan is mutated", async () => {
		const args = adoptionArgs();
		args.splice(args.indexOf("--session-id"), 2);
		await expectRejected(args, "ULW_LOOP_SESSION_SCOPE_REQUIRED");
		await writePlan(repo, adoptionPlan(), { sessionId: "other-session" });
		const sibling = await readFile(ulwLoopGoalsPath(repo, { sessionId: "other-session" }), "utf8");
		await expectRejected([...args, "--session-id", "other-session"], "ULW_LOOP_ADOPTION_SCOPE_MISMATCH");
		expect(await readFile(ulwLoopGoalsPath(repo, { sessionId: "other-session" }), "utf8")).toBe(sibling);
	});

	it.each(["--status", "--force", "--quality-gate-json", "--resume", "--expected-objective"])(
		"#when extra mutation/duplicate flag %s is supplied #then it cannot bypass the command",
		async (flag) => {
			await expectRejected([...adoptionArgs(), flag, "complete"], "ULW_LOOP_ADOPTION_ARGUMENT_INVALID");
		},
	);

	it("#when the native snapshot is read from a file #then that file remains byte-identical", async () => {
		const file = join(repo, "native.json");
		const bytes = `${JSON.stringify(nativeSnapshot(), null, 2)}\n`;
		await writeFile(file, bytes);
		const args = adoptionArgs();
		args[args.indexOf("--codex-goal-json") + 1] = file;
		expect(await run(args)).toMatchObject({ code: 0 });
		expect(await readFile(file, "utf8")).toBe(bytes);
	});

	it("#when the plan is per-story, already complete, or legacy #then no automatic migration or binding occurs", async () => {
		for (const [seed, code] of [
			[{ ...adoptionPlan(), codexGoalMode: "per_story" as const }, "ULW_LOOP_ADOPTION_MODE_UNSUPPORTED"],
			[
				{
					...adoptionPlan(),
					aggregateCompletion: { status: "complete" as const, completedAt: "2026-09-01", evidence: "done" },
				},
				"ULW_LOOP_ADOPTION_PLAN_COMPLETE",
			],
			[
				{ ...adoptionPlan(), codexObjective: "Complete all ulw-loop stories in .omo/ulw-loop/goals.json: legacy" },
				"ULW_LOOP_MIGRATION_REQUIRED",
			],
		] as const) {
			await writePlan(repo, seed, ADOPTION_SCOPE);
			await expectRejected(adoptionArgs(), code);
		}
	});

	it("#when concurrent explicit adoptions race #then the mutation lock produces one binding audit", async () => {
		const args = {
			goalId: "G002",
			expectedObjective: adoptionPlan().codexObjective ?? "",
			codexGoalJson: JSON.stringify(nativeSnapshot()),
			evidence: "authorized",
			rationale: "same scope",
		};
		const results = await Promise.all([
			adoptNativeGoal(repo, args, ADOPTION_SCOPE),
			adoptNativeGoal(repo, args, ADOPTION_SCOPE),
		]);
		expect(results.map((result) => result.adopted).sort()).toEqual([false, true]);
		expect((await readFile(ulwLoopLedgerPath(repo, ADOPTION_SCOPE), "utf8")).trim().split("\n")).toHaveLength(2);
	});

	it("#when audit append fails #then no unaudited alias is persisted", async () => {
		const before = await readFile(ulwLoopGoalsPath(repo, ADOPTION_SCOPE), "utf8");
		await rm(ulwLoopLedgerPath(repo, ADOPTION_SCOPE));
		await mkdir(ulwLoopLedgerPath(repo, ADOPTION_SCOPE));
		expect(await adopt()).toMatchObject({ code: 1 });
		expect(await readFile(ulwLoopGoalsPath(repo, ADOPTION_SCOPE), "utf8")).toBe(before);
	});
});
