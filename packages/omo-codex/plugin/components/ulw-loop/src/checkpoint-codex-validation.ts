import {
	canReconcileActiveFinalTaskScopedAggregateSnapshot,
	canReconcileCompletedTaskScopedAggregateSnapshot,
	codexSnapshotMismatchError,
} from "./checkpoint-reconciliation.js";
import {
	codexGoalSnapshotScopeMismatch,
	nativeGoalSnapshotRecord,
	readCodexGoalSnapshotInput,
	reconcileCodexGoalSnapshot,
} from "./codex-goal-snapshot.js";
import {
	codexGoalMode,
	compatibleCodexObjectives,
	expectedCodexObjective,
	isFinalRunCompletionCandidate,
} from "./goal-status.js";
import type { UlwLoopScope } from "./paths.js";
import type { UlwLoopItem, UlwLoopPlan } from "./types.js";
import { UlwLoopError } from "./types.js";

function normalizeObjective(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export async function validateCheckpointCodexGoal(input: {
	readonly repoRoot: string;
	readonly plan: UlwLoopPlan;
	readonly goal: UlwLoopItem;
	readonly raw: string | undefined;
	readonly evidence: string;
	readonly scope?: UlwLoopScope;
}): Promise<unknown> {
	const aggregate = codexGoalMode(input.plan) === "aggregate";
	const final = isFinalRunCompletionCandidate(input.plan, input.goal);
	const snapshot = await readCodexGoalSnapshotInput(input.raw, input.repoRoot);
	const binding = input.plan.nativeGoalBinding;
	if (binding !== undefined) {
		if (
			input.scope?.sessionId !== binding.sessionId ||
			codexGoalSnapshotScopeMismatch(snapshot?.raw, binding.sessionId) !== undefined
		) {
			throw new UlwLoopError(
				"Native snapshot and binding must match the selected session.",
				"ULW_LOOP_CODEX_SNAPSHOT_SCOPE_MISMATCH",
			);
		}
		const native = nativeGoalSnapshotRecord(snapshot?.raw);
		const status = native["status"];
		if (
			typeof native["objective"] !== "string" ||
			typeof status !== "string" ||
			status.toLowerCase() !== (final ? "complete" : "active")
		) {
			throw new UlwLoopError(
				"Adopted native snapshots require an explicit objective and ACTIVE intermediate / COMPLETE final status.",
				"ulw_loop_codex_snapshot_mismatch",
			);
		}
	}
	const expectedObjective = expectedCodexObjective(input.plan, input.goal);
	const reconciliation = reconcileCodexGoalSnapshot(snapshot, {
		expectedObjective,
		...(aggregate ? { acceptedObjectives: compatibleCodexObjectives(input.plan) } : {}),
		allowedStatuses: aggregate ? (final ? ["complete"] : ["active"]) : ["complete"],
		requireSnapshot: true,
		requireComplete: !aggregate || final,
	});
	if (reconciliation.ok) return reconciliation.snapshot.raw;
	// An explicit binding must never be weakened by legacy artifact/brief heuristics.
	if (binding !== undefined) throw codexSnapshotMismatchError({ reconciliation, snapshot, expectedObjective });
	const objective = snapshot?.objective;
	const mismatchedTaskObjective =
		snapshot?.available === true &&
		objective !== undefined &&
		normalizeObjective(objective) !== normalizeObjective(expectedObjective);
	const completedTaskScoped =
		mismatchedTaskObjective &&
		snapshot.status === "complete" &&
		(await canReconcileCompletedTaskScopedAggregateSnapshot(
			input.repoRoot,
			input.plan,
			input.goal,
			objective,
			input.evidence,
			input.scope,
		));
	const activeFinalTaskScoped =
		mismatchedTaskObjective &&
		snapshot.status === "active" &&
		(await canReconcileActiveFinalTaskScopedAggregateSnapshot(
			input.repoRoot,
			input.plan,
			input.goal,
			objective,
			input.evidence,
			input.scope,
		));
	if (completedTaskScoped || activeFinalTaskScoped) return reconciliation.snapshot.raw;
	throw codexSnapshotMismatchError({
		reconciliation,
		snapshot,
		expectedObjective,
		taskScopedHint: { goal: input.goal, aggregate, final },
	});
}

export function combineCheckpointValidationErrors(codexError: UlwLoopError, gateError: UlwLoopError): UlwLoopError {
	return new UlwLoopError(`${codexError.message}\n${gateError.message}`, "ULW_LOOP_QUALITY_GATE_INVALID", {
		details: { ...(codexError.details ?? {}), ...(gateError.details ?? {}) },
	});
}
