import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointUlwLoop } from "../src/checkpoint.js";
import { parseCodexGoalSnapshot } from "../src/codex-goal-snapshot.js";
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
import { qualityGateJson } from "./fixtures/quality-gate-builder.js";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "ulw-adoption-gates-"));
	await writePlan(repo, adoptionPlan(), ADOPTION_SCOPE);
	await writeFile(ulwLoopBriefPath(repo, ADOPTION_SCOPE), ADOPTION_BRIEF);
	await writeFile(ulwLoopLedgerPath(repo, ADOPTION_SCOPE), ADOPTION_LEDGER);
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

async function adopt(goalId = "G002", objective = NATIVE_OBJECTIVE) {
	return adoptNativeGoal(
		repo,
		{
			goalId,
			expectedObjective: adoptionPlan().codexObjective ?? "",
			codexGoalJson: JSON.stringify(nativeSnapshot("BLOCKED", objective)),
			evidence: "isolated authorization evidence",
			rationale: "same original scope",
		},
		ADOPTION_SCOPE,
	);
}

async function checkpoint(goalId: string, status: string, objective = NATIVE_OBJECTIVE, gate?: string) {
	return checkpointUlwLoop(
		repo,
		{
			goalId,
			status: "complete",
			evidence: "implementation complete and validation passed",
			codexGoalJson: JSON.stringify(nativeSnapshot(status, objective)),
			...(gate === undefined ? {} : { qualityGateJson: gate }),
		},
		ADOPTION_SCOPE,
	);
}

async function rejectsUnchanged(action: () => Promise<unknown>, code: string) {
	const paths = [ulwLoopGoalsPath(repo, ADOPTION_SCOPE), ulwLoopLedgerPath(repo, ADOPTION_SCOPE)];
	const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
	await expect(action()).rejects.toMatchObject({ code });
	expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
}

describe.each([
	{ phase: "intermediate", goalId: "G002", status: "COMPLETE", final: false },
	{ phase: "final", goalId: "G005", status: "ACTIVE", final: true },
])("#given a $phase legacy task-scoped snapshot", ({ goalId, status, final }) => {
	it.each([
		{ binding: "unadopted without alias", alias: false, adopted: false },
		{ binding: "unadopted with alias", alias: true, adopted: false },
		{ binding: "explicitly adopted with alias", alias: true, adopted: true },
	])("#when $binding #then only unadopted plans retain legacy reconciliation", async ({ alias, adopted }) => {
		const objective =
			"Complete all ulw-loop stories listed in .omo/ulw-loop/goals.json. Use .omo/ulw-loop/ledger.jsonl as the durable audit trail.";
		const seed = adoptionPlan();
		seed.codexObjectiveAliases = alias ? [objective] : [];
		seed.activeGoalId = goalId;
		for (const goal of seed.goals) {
			if (goal.id === goalId) goal.status = "in_progress";
			else if (final) goal.status = "complete";
			if (final) {
				for (const criterion of goal.successCriteria) {
					criterion.status = "pass";
					criterion.capturedEvidence = "isolated final proof";
				}
			}
		}
		await writePlan(repo, seed, ADOPTION_SCOPE);
		if (adopted) await adopt(goalId, objective);
		const gate = final ? await qualityGateJson(repo) : undefined;
		const action = () =>
			checkpointUlwLoop(
				repo,
				{
					goalId,
					status: "complete",
					evidence: `${goalId} implementation complete and validation passed; ledger.jsonl`,
					codexGoalJson: JSON.stringify(nativeSnapshot(status, objective)),
					...(gate === undefined ? {} : { qualityGateJson: gate }),
				},
				ADOPTION_SCOPE,
			);
		if (adopted) {
			await rejectsUnchanged(action, "ulw_loop_codex_snapshot_mismatch");
			return;
		}
		const result = await action();
		expect(result.goal.status).toBe("complete");
		expect(result.plan.aggregateCompletion?.status).toBe(final ? "complete" : undefined);
		expect(result.ledgerEntry.kind).toBe(final ? "aggregate_completed" : "goal_completed");
		expect(result.ledgerEntry.codexGoal).toEqual(nativeSnapshot(status, objective));
		expect(result.plan.codexObjectiveAliases).toEqual(seed.codexObjectiveAliases);
		expect(result.plan.nativeGoalBinding).toBeUndefined();
		expect(await readUlwLoopPlan(repo, ADOPTION_SCOPE)).toEqual(result.plan);
		if (!final) expect(result.plan.goals.slice(2)).toEqual(seed.goals.slice(2));
	});
});

describe("#given explicit native-goal binding", () => {
	it("#when parsing BLOCKED #then it is never normalized to active", () => {
		expect(parseCodexGoalSnapshot(nativeSnapshot())).toMatchObject({
			status: "blocked",
			objective: NATIVE_OBJECTIVE,
		});
	});

	it("#when G002 has all evidence #then adoption still requires a later active snapshot to checkpoint", async () => {
		await rejectsUnchanged(() => checkpoint("G002", "ACTIVE"), "ulw_loop_codex_snapshot_mismatch");
		await adopt();
		await rejectsUnchanged(() => checkpoint("G002", "BLOCKED"), "ulw_loop_codex_snapshot_mismatch");
		await rejectsUnchanged(() => checkpoint("G002", "COMPLETE"), "ulw_loop_codex_snapshot_mismatch");
		await rejectsUnchanged(
			() => checkpoint("G002", "ACTIVE", "unrelated objective"),
			"ulw_loop_codex_snapshot_mismatch",
		);
		// A separate fixture represents a fresh get_goal after the USER resumes; adoption never edits it.
		const result = await checkpoint("G002", "ACTIVE");
		expect(result.goal.status).toBe("complete");
		expect(result.plan.aggregateCompletion).toBeUndefined();
		expect(result.plan.goals.slice(2)).toEqual(adoptionPlan().goals.slice(2));
		expect(result.ledgerEntry.codexGoal).toEqual(nativeSnapshot("ACTIVE"));
		await rejectsUnchanged(() => checkpoint("G003", "ACTIVE"), "ulw_loop_criteria_not_all_pass");
	});

	it("#when a bound artifact-bearing objective reaches the final goal #then no task-scoped fallback bypasses native completion or quality gates", async () => {
		const seed = adoptionPlan();
		for (const goal of seed.goals) {
			goal.status = goal.id === "G005" ? "in_progress" : "complete";
			for (const criterion of goal.successCriteria) {
				criterion.status = "pass";
				criterion.capturedEvidence = "isolated final proof";
			}
		}
		seed.activeGoalId = "G005";
		await writePlan(repo, seed, ADOPTION_SCOPE);
		const objective = `${NATIVE_OBJECTIVE}\nUse .omo/ulw-loop/goals.json and every original constraint.`;
		await adopt("G005", objective);
		const gate = await qualityGateJson(repo);
		await rejectsUnchanged(() => checkpoint("G005", "ACTIVE", objective, gate), "ulw_loop_codex_snapshot_mismatch");
		await rejectsUnchanged(() => checkpoint("G005", "BLOCKED", objective, gate), "ulw_loop_codex_snapshot_mismatch");
		await rejectsUnchanged(() => checkpoint("G005", "COMPLETE", objective), "ULW_LOOP_QUALITY_GATE_INVALID");
		await rejectsUnchanged(
			() => checkpoint("G005", "COMPLETE", "unrelated objective", gate),
			"ulw_loop_codex_snapshot_mismatch",
		);
		const result = await checkpoint("G005", "COMPLETE", objective, gate);
		expect(result.plan.aggregateCompletion?.status).toBe("complete");
		expect(result.ledgerEntry.kind).toBe("aggregate_completed");
	});

	it("#when later criteria remain pending #then a complete native snapshot cannot complete the run", async () => {
		const seed = adoptionPlan();
		for (const goal of seed.goals) goal.status = goal.id === "G005" ? "in_progress" : "complete";
		seed.activeGoalId = "G005";
		await writePlan(repo, seed, ADOPTION_SCOPE);
		await adopt("G005");
		await rejectsUnchanged(
			() => checkpoint("G005", "COMPLETE", NATIVE_OBJECTIVE, "{}"),
			"ulw_loop_criteria_not_all_pass",
		);
		expect((await readUlwLoopPlan(repo, ADOPTION_SCOPE)).aggregateCompletion).toBeUndefined();
	});
});
