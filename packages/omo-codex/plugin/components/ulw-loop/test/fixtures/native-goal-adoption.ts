import { aggregateCodexObjectiveForScope } from "../../src/goal-status.js";
import { ulwLoopBriefRelativePath, ulwLoopGoalsRelativePath, ulwLoopLedgerRelativePath } from "../../src/paths.js";
import { goal, plan } from "./checkpoint-builders.js";

export const ADOPTION_SCOPE = { sessionId: "isolated-native-adoption" };
export const NATIVE_OBJECTIVE = "  원래 승인된 상세 목표를 보존한다.\nG002 이후 G003-G005와 모든 검증을 끝낸다.  ";
export const ADOPTION_BRIEF = "Original constraints: preserve every phase, criterion and captured proof.\n";
export const ADOPTION_LEDGER =
	'{"at":"2026-09-01T00:00:00.000Z","kind":"goal_completed","goalId":"G001","evidence":"original captured proof"}\n';

export function adoptionPlan() {
	return plan(
		[
			goal({
				id: "G001",
				status: "complete",
				completedAt: "2026-09-01T00:00:00.000Z",
				evidence: "merged phase one",
			}),
			goal({
				id: "G002",
				status: "blocked",
				attempt: 2,
				blockedReason: "native objective binding mismatch",
				evidence: "merged phase two; all criteria pass",
			}),
			...["G003", "G004", "G005"].map((id) =>
				goal({
					id,
					status: "pending",
					attempt: 0,
					successCriteria: [
						{
							id: "C001",
							scenario: `${id} must ship`,
							userModel: "happy",
							expectedEvidence: "real surface proof",
							capturedEvidence: null,
							status: "pending",
						},
					],
				}),
			),
		],
		{
			codexObjective: aggregateCodexObjectiveForScope(ADOPTION_SCOPE),
			briefPath: ulwLoopBriefRelativePath(ADOPTION_SCOPE),
			goalsPath: ulwLoopGoalsRelativePath(ADOPTION_SCOPE),
			ledgerPath: ulwLoopLedgerRelativePath(ADOPTION_SCOPE),
		},
	);
}

export function nativeSnapshot(status = "BLOCKED", objective = NATIVE_OBJECTIVE) {
	return { goal: { id: "native-fixture", threadId: ADOPTION_SCOPE.sessionId, objective, status, tokensUsed: 1234 } };
}
