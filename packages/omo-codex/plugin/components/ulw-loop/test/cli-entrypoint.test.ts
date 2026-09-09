import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ulwLoopBriefPath, ulwLoopGoalsPath, ulwLoopLedgerPath } from "../src/paths.js";
import { writePlan } from "../src/plan-io.js";
import {
	ADOPTION_BRIEF,
	ADOPTION_LEDGER,
	ADOPTION_SCOPE,
	adoptionPlan,
	NATIVE_OBJECTIVE,
	nativeSnapshot,
} from "./fixtures/native-goal-adoption.js";
import { qualityGateJson } from "./fixtures/quality-gate-builder.js";

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtCli = join(componentRoot, "dist", "cli.js");

type CliResult = {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

function sanitizedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env["CODEX_SESSION_ID"];
	delete env["CODEX_THREAD_ID"];
	delete env["OMO_ULW_LOOP_SESSION_ID"];
	delete env["PI_SESSION_ID"];
	return env;
}

async function runProcess(command: string, args: readonly string[], cwd: string): Promise<CliResult> {
	return runProcessWithInput(command, args, cwd, "");
}

async function runProcessWithInput(
	command: string,
	args: readonly string[],
	cwd: string,
	input: string,
): Promise<CliResult> {
	return new Promise((resolvePromise, reject) => {
		const env =
			command === process.execPath
				? {
						PATH: process.env["PATH"],
						HOME: cwd,
						CODEX_HOME: join(cwd, "codex-home"),
						OMO_CODING_AGENT_DIR: join(cwd, "omo-home"),
						SENPI_CODING_AGENT_DIR: join(cwd, "senpi-home"),
						PI_CODING_AGENT_DIR: join(cwd, "pi-home"),
						XDG_CONFIG_HOME: join(cwd, "config"),
						XDG_DATA_HOME: join(cwd, "data"),
						XDG_STATE_HOME: join(cwd, "state"),
						XDG_CACHE_HOME: join(cwd, "cache"),
						OMO_AGENT_TOOLKIT_SURFACE: "lazycodex",
					}
				: sanitizedEnv();
		const child = spawn(command, [...args], { cwd, env, timeout: 60_000 });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.stdin.end(input);
	});
}

let workspace: string;

async function runCli(args: readonly string[], input = ""): Promise<CliResult> {
	return runProcessWithInput(process.execPath, [builtCli, ...args], workspace, input);
}

async function adoptedCheckpointFixture(final: boolean) {
	const seed = adoptionPlan();
	const goalId = final ? "G005" : "G002";
	if (final) {
		seed.activeGoalId = goalId;
		for (const goal of seed.goals) {
			goal.status = goal.id === goalId ? "in_progress" : "complete";
			for (const criterion of goal.successCriteria) {
				criterion.status = "pass";
				criterion.capturedEvidence = "synthetic final fixture proof";
			}
		}
	}
	await writePlan(workspace, seed, ADOPTION_SCOPE);
	await writeFile(ulwLoopBriefPath(workspace, ADOPTION_SCOPE), ADOPTION_BRIEF);
	await writeFile(ulwLoopLedgerPath(workspace, ADOPTION_SCOPE), ADOPTION_LEDGER);
	const adopted = await runCli([
		"adopt-native-goal",
		"--session-id",
		ADOPTION_SCOPE.sessionId,
		"--goal-id",
		goalId,
		"--expected-objective",
		seed.codexObjective ?? "",
		"--codex-goal-json",
		JSON.stringify(nativeSnapshot()),
		"--evidence",
		"authorized synthetic fixture",
		"--rationale",
		"same scope",
		"--json",
	]);
	expect(adopted.code, adopted.stdout || adopted.stderr).toBe(0);
	expect(JSON.parse(adopted.stdout).plan.nativeGoalBinding).toEqual(ADOPTION_SCOPE);
	const gate = final ? ["--quality-gate-json", await qualityGateJson(workspace)] : [];
	return async (snapshot: unknown, accepted = false, errorCode = "ulw_loop_codex_snapshot_mismatch") => {
		const snapshotPath = join(workspace, "checkpoint-synthetic.json");
		await writeFile(snapshotPath, JSON.stringify(snapshot));
		const paths = [
			ulwLoopGoalsPath(workspace, ADOPTION_SCOPE),
			ulwLoopLedgerPath(workspace, ADOPTION_SCOPE),
			ulwLoopBriefPath(workspace, ADOPTION_SCOPE),
			snapshotPath,
		];
		const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		const result = await runCli([
			"checkpoint",
			"--session-id",
			ADOPTION_SCOPE.sessionId,
			"--goal-id",
			goalId,
			"--status",
			"complete",
			"--evidence",
			"Fixture implementation complete and validation passed",
			"--no-advance",
			"--codex-goal-json",
			snapshotPath,
			...gate,
			"--json",
		]);
		expect(result.stderr).toBe("");
		const after = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		expect.soft(result.code, result.stdout).toBe(accepted ? 0 : 1);
		if (accepted) {
			expect(JSON.parse(result.stdout)).toMatchObject({ goal: { id: goalId, status: "complete" } });
			expect(JSON.parse(result.stdout).plan.aggregateCompletion?.status).toBe(final ? "complete" : undefined);
			expect(after.slice(2)).toEqual(before.slice(2));
		} else {
			expect.soft(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: errorCode } });
			expect(after).toEqual(before);
		}
	};
}

beforeAll(async () => {
	const build =
		process.platform === "win32"
			? await runProcess("cmd.exe", ["/c", "npm", "run", "build"], componentRoot)
			: await runProcess("npm", ["run", "build"], componentRoot);
	expect(build.code, `npm run build failed:\n${build.stderr}`).toBe(0);
}, 120_000);

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), "ulw-loop-entrypoint-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

describe("dist/cli.js entrypoint dispatch", () => {
	it.each(
		[false, true].flatMap((final) =>
			["root", "goal"].flatMap((level) =>
				["threadId", "thread_id", "sessionId", "session_id"].map((key) => ({ final, level, key })),
			),
		),
	)(
		"#given adopted final=$final #when $level.$key is foreign #then F1 rejects without mutation",
		async ({ final, level, key }) => {
			const checkpoint = await adoptedCheckpointFixture(final);
			const snapshot = nativeSnapshot(final ? "COMPLETE" : "ACTIVE");
			await checkpoint(
				level === "root"
					? { ...snapshot, [key]: "other-thread" }
					: {
							...snapshot,
							goal: { ...snapshot.goal, [key]: "other-thread" },
						},
				false,
				"ULW_LOOP_CODEX_SNAPSHOT_SCOPE_MISMATCH",
			);
		},
	);

	it.each(["ACTIVE", "COMPLETE"])(
		"#given adopted final #when unrelated ledger.jsonl objective is %s #then F2 rejects without mutation",
		async (status) => {
			const checkpoint = await adoptedCheckpointFixture(true);
			await checkpoint(nativeSnapshot(status, "Unrelated objective; ledger.jsonl"));
		},
	);

	it.each([false, true])(
		"#given adopted final=%s #when compatible current-session snapshot has required status #then checkpoint succeeds",
		async (final) => {
			const checkpoint = await adoptedCheckpointFixture(final);
			const snapshot = nativeSnapshot(final ? "COMPLETE" : "ACTIVE");
			const metadata = {
				threadId: ADOPTION_SCOPE.sessionId,
				thread_id: ADOPTION_SCOPE.sessionId,
				sessionId: ADOPTION_SCOPE.sessionId,
				session_id: ADOPTION_SCOPE.sessionId,
			};
			await checkpoint({ ...snapshot, ...metadata, goal: { ...snapshot.goal, ...metadata } }, true);
		},
	);

	it.each([false, true])(
		"#given adopted final=%s #when native scope metadata is omitted #then explicit fields still permit completion",
		async (final) => {
			const checkpoint = await adoptedCheckpointFixture(final);
			await checkpoint({ objective: NATIVE_OBJECTIVE, status: final ? "complete" : "active" }, true);
		},
	);

	it.each([false, true])(
		"#given adopted final=%s #when native fields use legacy fallbacks or metadata is null #then rejects unchanged",
		async (final) => {
			const checkpoint = await adoptedCheckpointFixture(final);
			const status = final ? "COMPLETE" : "ACTIVE";
			await checkpoint({ goal: { title: NATIVE_OBJECTIVE, status } });
			await checkpoint(nativeSnapshot(final ? "done" : "running"));
			await checkpoint(
				{ ...nativeSnapshot(status), sessionId: null },
				false,
				"ULW_LOOP_CODEX_SNAPSHOT_SCOPE_MISMATCH",
			);
		},
	);

	it("#given blocked G002 #when the built CLI adopts an unchanged native snapshot #then audit, preservation and checkpoint gates hold", async () => {
		const seed = adoptionPlan();
		await writePlan(workspace, seed, ADOPTION_SCOPE);
		await writeFile(ulwLoopBriefPath(workspace, ADOPTION_SCOPE), ADOPTION_BRIEF);
		await writeFile(ulwLoopLedgerPath(workspace, ADOPTION_SCOPE), ADOPTION_LEDGER);
		const snapshotPath = join(workspace, "native.json");
		const snapshotBytes = JSON.stringify(nativeSnapshot());
		await writeFile(snapshotPath, snapshotBytes);
		const args = [
			"ulw-loop",
			"adopt-native-goal",
			"--session-id",
			ADOPTION_SCOPE.sessionId,
			"--goal-id",
			"G002",
			"--expected-objective",
			seed.codexObjective ?? "",
			"--codex-goal-json",
			snapshotPath,
			"--evidence",
			"authorized same-scope fixture",
			"--rationale",
			"preserve native objective",
			"--json",
		];
		const adopted = await runCli(args);
		expect(adopted.code, adopted.stderr || adopted.stdout).toBe(0);
		expect(JSON.parse(adopted.stdout)).toMatchObject({
			adopted: true,
			plan: { codexObjective: seed.codexObjective, codexObjectiveAliases: [NATIVE_OBJECTIVE], goals: seed.goals },
		});
		const paths = [
			ulwLoopGoalsPath(workspace, ADOPTION_SCOPE),
			ulwLoopLedgerPath(workspace, ADOPTION_SCOPE),
			ulwLoopBriefPath(workspace, ADOPTION_SCOPE),
			snapshotPath,
		];
		const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		expect(JSON.parse((await runCli(args)).stdout)).toMatchObject({ adopted: false });
		expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
		const checkpointArgs = [
			"checkpoint",
			"--session-id",
			ADOPTION_SCOPE.sessionId,
			"--goal-id",
			"G002",
			"--status",
			"complete",
			"--evidence",
			"implementation complete and validation passed",
			"--no-advance",
			"--json",
			"--codex-goal-json",
		];
		for (const snapshot of [nativeSnapshot(), nativeSnapshot("ACTIVE", "unrelated native objective")]) {
			const rejected = await runCli([...checkpointArgs, JSON.stringify(snapshot)]);
			expect(rejected.code).toBe(1);
			expect(JSON.parse(rejected.stdout)).toMatchObject({ error: { code: "ulw_loop_codex_snapshot_mismatch" } });
		}
		expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
		const checkpoint = await runCli([...checkpointArgs, JSON.stringify(nativeSnapshot("ACTIVE"))]);
		expect(checkpoint.code, checkpoint.stderr || checkpoint.stdout).toBe(0);
		expect(JSON.parse(checkpoint.stdout)).toMatchObject({ goal: { id: "G002", status: "complete" } });
		expect(await readFile(snapshotPath, "utf8")).toBe(snapshotBytes);
	});

	it("#given no plan #when invoked with bare 'status --json' #then routes into ulw-loop instead of unknown command", async () => {
		const result = await runCli(["status", "--session-id", "s1", "--json"]);

		const combined = `${result.stdout}${result.stderr}`;
		expect(combined).toContain("No ulw-loop plan found");
		expect(combined).not.toContain("[omo] unknown command");
		expect(result.code).toBe(1);
	});

	it("#given no plan #when invoked with legacy 'ulw-loop status --json' #then still routes into ulw-loop", async () => {
		const result = await runCli(["ulw-loop", "status", "--session-id", "s1", "--json"]);

		const combined = `${result.stdout}${result.stderr}`;
		expect(combined).toContain("No ulw-loop plan found");
		expect(combined).not.toContain("[omo] unknown command");
		expect(result.code).toBe(1);
	});

	it("#given no session flag and no session env #when invoked with 'status --json' #then refuses the unscoped root instead of reading it", async () => {
		const result = await runCli(["status", "--json"]);

		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: "ULW_LOOP_SESSION_SCOPE_REQUIRED", details: { flag: "--session-id" } },
		});
	});

	it("#given the top-level entrypoint #when invoked with 'help' #then prints the merged hook and subcommand usage and exits 0", async () => {
		const result = await runCli(["help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("hook user-prompt-submit");
		expect(result.stdout).toContain("create-goals");
		expect(result.stdout).toContain("complete-goals");
		expect(result.stdout).toContain("record-review-blockers");
		expect(result.stdout).not.toContain("for ulw-loop subcommands");
	});

	it("#given the staged router strips nothing #when invoked with 'ulw-loop help' #then prints the same merged help text", async () => {
		const bare = await runCli(["help"]);
		const nested = await runCli(["ulw-loop", "help"]);

		expect(nested.code).toBe(0);
		expect(nested.stdout.trim()).toBe(bare.stdout.trim());
		expect(nested.stdout).toContain("hook user-prompt-submit");
		expect(nested.stdout).toContain("record-review-blockers");
		expect(nested.stdout).not.toContain("for ulw-loop subcommands");
	});

	it("#given a subcommand with required args #when invoked with 'create-goals --help' #then prints its usage and exits 0", async () => {
		const result = await runCli(["create-goals", "--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("create-goals");
		expect(`${result.stdout}${result.stderr}`).not.toContain("Missing brief text");
	});

	it("#given a command outside the ulw-loop vocabulary #when invoked with 'frobnicate' #then fails as unknown command", async () => {
		const result = await runCli(["frobnicate"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("[omo] unknown command: frobnicate");
	});

	it("#given standalone ulw-loop hook asks for ultrawork context #when user prompt is ulw #then emits the ultrawork directive", async () => {
		const payload = {
			cwd: workspace,
			hook_event_name: "UserPromptSubmit",
			model: "gpt-5.5",
			permission_mode: "default",
			prompt: "ulw this change",
			session_id: "s1",
			transcript_path: null,
			turn_id: "t1",
		};

		const result = await runCli(["hook", "user-prompt-submit", "--with-ultrawork"], `${JSON.stringify(payload)}\n`);
		const parsed = JSON.parse(result.stdout);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(parsed.hookSpecificOutput.additionalContext).toMatch(/^<ultrawork-mode>/);
	});
});
