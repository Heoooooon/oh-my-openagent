import {
	type CodexGoalSnapshot,
	CodexGoalSnapshotError,
	codexGoalSnapshotScopeMismatch,
	nativeGoalSnapshotRecord,
	readCodexGoalSnapshotInput,
} from "./codex-goal-snapshot.js";
import { codexGoalMode, compatibleCodexObjectives, isUlwLoopDone } from "./goal-status.js";
import {
	normalizeUlwLoopSessionId,
	type UlwLoopScope,
	ulwLoopBriefRelativePath,
	ulwLoopGoalsRelativePath,
	ulwLoopLedgerRelativePath,
} from "./paths.js";
import { appendLedger, readUlwLoopPlan, withUlwLoopMutationLock, writePlan } from "./plan-io.js";
import { iso, UlwLoopError, type UlwLoopLedgerEntry, type UlwLoopPlan } from "./types.js";

export interface AdoptNativeGoalArgs {
	readonly goalId: string;
	readonly expectedObjective: string;
	readonly codexGoalJson: string;
	readonly evidence: string;
	readonly rationale: string;
}

function fail(message: string, code: string): never {
	throw new UlwLoopError(message, `ULW_LOOP_ADOPTION_${code}`);
}

function validatePlan(plan: UlwLoopPlan, args: AdoptNativeGoalArgs, scope: UlwLoopScope): void {
	if (codexGoalMode(plan) !== "aggregate") fail("Native binding requires aggregate mode.", "MODE_UNSUPPORTED");
	if (isUlwLoopDone(plan)) fail("Cannot adopt into a completed plan.", "PLAN_COMPLETE");
	if (
		plan.goalsPath !== ulwLoopGoalsRelativePath(scope) ||
		plan.briefPath !== ulwLoopBriefRelativePath(scope) ||
		plan.ledgerPath !== ulwLoopLedgerRelativePath(scope)
	)
		fail("Plan artifact paths do not match the selected session.", "SCOPE_MISMATCH");
	if (!plan.codexObjective || args.expectedObjective !== plan.codexObjective) {
		fail(
			"Expected objective does not exactly match the original plan codexObjective; read status again.",
			"OBJECTIVE_MISMATCH",
		);
	}
	const goal = plan.goals.find((candidate) => candidate.id === args.goalId);
	if (goal === undefined) fail(`Unknown loop goal: ${args.goalId}.`, "GOAL_NOT_FOUND");
	if (
		(goal.status !== "in_progress" && goal.status !== "blocked") ||
		goal.steeringStatus !== undefined ||
		(plan.activeGoalId !== undefined && plan.activeGoalId !== goal.id)
	)
		fail(
			"Binding requires the current in-progress or blocked loop goal; it cannot start or resume a goal.",
			"GOAL_STATUS_UNSUPPORTED",
		);
}

export async function adoptNativeGoal(
	repoRoot: string,
	args: AdoptNativeGoalArgs,
	scope: UlwLoopScope,
): Promise<{ readonly adopted: boolean; readonly plan: UlwLoopPlan; readonly ledgerEntry?: UlwLoopLedgerEntry }> {
	const sessionId = scope.sessionId;
	if (!sessionId || normalizeUlwLoopSessionId(sessionId) !== sessionId)
		fail("Native binding requires a canonical session id.", "SCOPE_REQUIRED");
	if (!args.evidence.trim() || !args.rationale.trim())
		fail("Evidence and rationale are required.", "EVIDENCE_REQUIRED");
	return withUlwLoopMutationLock(repoRoot, scope, async () => {
		// Adoption must not trigger the read helper's legacy objective rewrite.
		const plan = await readUlwLoopPlan(repoRoot, scope, { migrateLegacyObjective: false });
		validatePlan(plan, args, scope);
		let snapshot: CodexGoalSnapshot | null;
		try {
			snapshot = await readCodexGoalSnapshotInput(args.codexGoalJson, repoRoot);
		} catch (error) {
			if (!(error instanceof CodexGoalSnapshotError)) throw error;
			throw new UlwLoopError(error.message, "ULW_LOOP_ADOPTION_SNAPSHOT_INVALID", { cause: error });
		}
		if (!snapshot?.available || !snapshot.objective)
			fail("A native goal snapshot with an objective is required.", "SNAPSHOT_INVALID");
		const native = nativeGoalSnapshotRecord(snapshot.raw);
		if (typeof native["objective"] !== "string" || !native["objective"].trim()) {
			fail(
				"Native snapshot must contain explicit objective text, not a title or description fallback.",
				"SNAPSHOT_INVALID",
			);
		}
		const status = native["status"];
		if (typeof status !== "string" || !["active", "blocked"].includes(status.toLowerCase())) {
			fail(
				"Only ACTIVE or BLOCKED native goals can be bound; adoption is not completion or resume.",
				"STATUS_UNSUPPORTED",
			);
		}
		const mismatch = codexGoalSnapshotScopeMismatch(snapshot.raw, sessionId);
		if (mismatch !== undefined || (plan.nativeGoalBinding && plan.nativeGoalBinding.sessionId !== sessionId))
			fail(`Native binding and snapshot metadata must match session ${sessionId}.`, "SCOPE_MISMATCH");
		const objective = snapshot.objective;
		const normalized = objective.replace(/\s+/g, " ").trim();
		const compatible = compatibleCodexObjectives(plan).some(
			(value) => value.replace(/\s+/g, " ").trim() === normalized,
		);
		if (compatible && plan.nativeGoalBinding !== undefined) {
			return { adopted: false, plan };
		}
		const now = iso();
		const aliases = compatible
			? (plan.codexObjectiveAliases ?? [])
			: [...(plan.codexObjectiveAliases ?? []), objective];
		const nativeGoalBinding = { sessionId };
		const ledgerEntry: UlwLoopLedgerEntry = {
			at: now,
			kind: "native_goal_adopted",
			goalId: args.goalId,
			evidence: args.evidence,
			message: args.rationale,
			codexGoal: snapshot.raw,
			before: {
				sessionId: scope.sessionId,
				codexObjective: plan.codexObjective,
				codexObjectiveAliases: plan.codexObjectiveAliases ?? [],
				nativeGoalBinding: plan.nativeGoalBinding ?? null,
			},
			after: {
				sessionId: scope.sessionId,
				codexObjective: plan.codexObjective,
				codexObjectiveAliases: aliases,
				nativeGoalBinding,
			},
		};
		// Audit first: an audit write failure must never grant unaudited compatibility.
		await appendLedger(repoRoot, ledgerEntry, scope);
		if (!compatible) plan.codexObjectiveAliases = aliases;
		plan.nativeGoalBinding = nativeGoalBinding;
		plan.updatedAt = now;
		await writePlan(repoRoot, plan, scope);
		return { adopted: true, plan, ledgerEntry };
	});
}
