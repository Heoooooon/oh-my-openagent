import { readValue } from "./cli-arg-parser.js";
import { printJson } from "./cli-output.js";
import { adoptNativeGoal } from "./native-goal-adoption.js";
import type { UlwLoopScope } from "./paths.js";
import { UlwLoopError } from "./types.js";

const VALUE_FLAGS = [
	"--session-id",
	"--goal-id",
	"--expected-objective",
	"--codex-goal-json",
	"--evidence",
	"--rationale",
] as const;

function required(argv: readonly string[], flag: string): string {
	const value = readValue(argv, flag);
	if (value?.trim()) return value;
	throw new UlwLoopError(`Missing ${flag}.`, "ULW_LOOP_ARGUMENT_MISSING", { details: { flag } });
}

export async function adoptNativeGoalCommand(
	repoRoot: string,
	argv: readonly string[],
	json: boolean,
	scope: UlwLoopScope,
): Promise<number> {
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const flag = arg.split("=")[0] ?? "";
		if (seen.has(flag) || (flag !== "--json" && !VALUE_FLAGS.some((value) => value === flag))) {
			throw new UlwLoopError(
				`Unsupported or repeated adoption argument: ${arg}.`,
				"ULW_LOOP_ADOPTION_ARGUMENT_INVALID",
			);
		}
		seen.add(flag);
		if (flag !== "--json" && !arg.includes("=")) index += 1;
	}
	const result = await adoptNativeGoal(
		repoRoot,
		{
			goalId: required(argv, "--goal-id"),
			expectedObjective: required(argv, "--expected-objective"),
			codexGoalJson: required(argv, "--codex-goal-json"),
			evidence: required(argv, "--evidence"),
			rationale: required(argv, "--rationale"),
		},
		scope,
	);
	if (json) printJson({ ok: true, ...result });
	else
		process.stdout.write(
			`ulw-loop native goal ${result.adopted ? "binding adopted" : "already compatible"}; no goals resumed or completed.\n`,
		);
	return 0;
}
