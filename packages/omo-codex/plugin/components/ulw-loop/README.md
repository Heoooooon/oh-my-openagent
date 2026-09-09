# codex-ulw-loop

[![ci](https://img.shields.io/badge/ci-pending-lightgrey.svg)](#) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex plugin component for durable repo-native multi-goal orchestration with embedded success criteria and observable evidence audit. State lives under `.omo/ulw-loop/` and is mutated through the `omo-agent-toolkit ulw-loop` CLI.

## CLI

Every subcommand below is implemented. Pass `--json` where supported for machine-readable output, and pass `--session-id <id>` or set `OMO_ULW_LOOP_SESSION_ID` to scope state to a parallel session.

| Subcommand | Purpose |
|------------|---------|
| `omo-agent-toolkit ulw-loop help` | Print CLI usage. |
| `omo-agent-toolkit ulw-loop create-goals` | Create repo-native goals and seed success criteria from a brief; optionally define review-boundary validation batches with `--validation-batch-json`. |
| `omo-agent-toolkit ulw-loop status` | Report active goal, criteria, and evidence state. |
| `omo-agent-toolkit ulw-loop complete-goals` | Manual fallback to start or resume the next eligible goal, or report aggregate completion / blocked handoff. |
| `omo-agent-toolkit ulw-loop checkpoint` | Gate a goal transition with evidence; complete checkpoints auto-start the next eligible goal by default, with `--no-advance` preserving the legacy two-call flow. |
| `omo-agent-toolkit ulw-loop steer` | Apply one steering mutation proposal or an atomic all-or-nothing batch with `--proposals-json`. |
| `omo-agent-toolkit ulw-loop add-goal` | Append a goal to the active plan. |
| `omo-agent-toolkit ulw-loop criteria` | Inspect one goal's success criteria. |
| `omo-agent-toolkit ulw-loop record-evidence` | Record observable evidence for one criterion. |
| `omo-agent-toolkit ulw-loop record-review-blockers` | Mark a goal as review-blocked and add follow-up work from final-review findings. |
| `omo-agent-toolkit ulw-loop adopt-native-goal` | Explicitly audit and bind an unchanged native objective to an unfinished aggregate plan; never start, resume or complete goals. |

The final quality gate parsed by `checkpoint` requires `manualQa`, `gateReview`, `iteration`, and `criteriaCoverage`; lazycodex accepts optional `codeReview`. Lazycodex defaults to `main-session` self-review, with `category:*` and reviewer acceptors available when needed. `criteriaCoverage` records the original intent, desired outcome, user-facing outcome review, pass counts, and covered adversarial classes. The companion `codex-goal-json` must contain the plan's `codexObjective` or an explicitly compatible aggregate objective (whitespace-normalized comparison).

### Repair an unchanged native-goal binding

Do not replace the native objective with the loop's generated pointer, reset the loop, or fabricate a matching snapshot. If the user authorizes binding the existing native objective to the original aggregate plan, inspect `status --json`, capture a fresh, unmodified `get_goal` response, and run:

```sh
omo-agent-toolkit ulw-loop adopt-native-goal \
  --session-id <existing-session-id> --goal-id <current-blocked-or-in-progress-goal-id> \
  --expected-objective '<exact original plan codexObjective from status>' \
  --codex-goal-json <fresh-native-snapshot.json> \
  --evidence '<user authorization and evidence linking the native goal to this plan>' \
  --rationale '<why the unchanged objective covers every original phase and constraint>' --json
```

This explicit operation requires nonempty evidence/rationale and exact confirmation of the original objective. It checks the session's artifact paths and every provided `threadId`/`thread_id`/`sessionId`/`session_id` at the snapshot root and goal. Without native scope metadata, the selected CLI session and supplied evidence are the caller's attestation; this offline CLI cannot independently authenticate a snapshot or prove its freshness. Pass the real snapshot, not a rewritten objective/status. Existing session environment variables can supply scope instead of `--session-id`.

Only an unfinished aggregate plan with a current blocked/in-progress loop goal and an explicit ACTIVE or BLOCKED native goal objective is supported. Per-story mode, completed plans, other statuses, stale expected objectives, malformed/empty/no-goal snapshots, incompatible sessions and extra mutation flags are rejected. Legacy objectives requiring automatic migration are rejected without rewriting them.

The mutation lock covers validation, audit and binding persistence. `native_goal_adopted` appends the raw snapshot, session, target, original objective, compatible objectives, binding metadata, evidence and rationale to the existing ledger before adding compatibility; audit failure cannot grant a binding. The plan records `nativeGoalBinding: {sessionId}` to distinguish explicit adoption from legacy compatibility aliases. First adoption records this binding even if the objective was already compatible, without duplicating aliases. As with other plan/ledger operations, these are separate filesystem writes, not a two-file transaction: if the plan write fails, inspect the audit and retry the explicit command. Repeating an already-compatible, explicitly adopted binding returns `adopted: false` without changing plan bytes, timestamps or the ledger.

The original `codexObjective`, brief, goals, statuses, attempts, criteria and captured evidence remain unchanged. Adoption does **not** resume the native goal or checkpoint the loop. A BLOCKED snapshot still fails an active intermediate checkpoint: the user must issue `/goal resume`, then supply a genuine fresh ACTIVE `get_goal` snapshot. Every adopted completion checkpoint requires an explicit compatible objective (whitespace-normalized exact equality), the bound session, and matching root/goal scope metadata whenever provided. Intermediate snapshots must explicitly be ACTIVE; final snapshots must explicitly be COMPLETE, with all later criteria/batch and quality gates still required. Unrelated objectives cannot use legacy artifact/brief heuristics to bypass this binding, even if they mention `ledger.jsonl`. Unadopted plans retain their legacy reconciliation behavior; there is no per-checkpoint adoption flag.

A complete passing checkpoint uses both payloads:

```json
{"goal":{"objective":"Ship the requested behavior","status":"complete"}}
```

```json
{"gateReview":{"by":"main-session","recommendation":"APPROVE","reportPath":".omo/evidence/gate-review.md","evidence":"Gate review passed.","blockers":[],"notes":[]},"manualQa":{"by":"lazycodex-qa-executor","status":"passed","evidence":"Manual QA passed.","surfaceEvidence":[{"id":"cli","criterionRef":"C1","surface":"cli","invocation":"omo-agent-toolkit ulw-loop checkpoint --json","verdict":"passed","artifactRefs":["cli-artifact"]}],"adversarialCases":[{"id":"malformed","criterionRef":"C2","scenario":"Malformed input","expectedBehavior":"Rejected","verdict":"not_applicable","reason":"Not triggered","artifactRefs":["cli-artifact"]}],"artifactRefs":[{"id":"cli-artifact","kind":"cli-transcript","description":"Passing CLI transcript","path":".omo/evidence/cli.txt"}]},"codeReview":{"by":"lazycodex-code-reviewer","recommendation":"APPROVE","codeQualityStatus":"CLEAR","reportPath":".omo/evidence/code-review.md","evidence":"Code review passed.","blockers":[]},"iteration":{"fullRerun":true,"status":"passed","rerunCommands":["bun test"],"evidence":"Full rerun passed."},"criteriaCoverage":{"totalCriteria":2,"passCount":2,"originalIntent":"Ship the requested behavior","desiredOutcome":"The behavior works for users.","userOutcomeReview":"The result matches the requested outcome.","adversarialClassesCovered":["malformed_input"]}}
```

Validation batches are optional review boundaries declared at plan creation with `--validation-batch-json '[{"batchId":"VB001","memberIds":[...],"finalGoalId":"..."}]'`. The batch-final goal cannot complete until every other member is complete or superseded-resolved, every member criterion is pass, and a quality gate's coverage counts match the recomputed member criteria. Steering split/supersede mutations keep batch membership consistent and record `batch_updated`.

## Codex Plugin

This directory is a component of the aggregate `@sisyphuslabs/omo-codex-plugin` root. Plugin discovery (`.codex-plugin/plugin.json`) is owned by that aggregate root, not by this component. The component ships:

- `hooks/hooks.json` registering four hooks:
  - `UserPromptSubmit` -> `node "${PLUGIN_ROOT}/dist/cli.js" hook user-prompt-submit --with-ultrawork`
  - `PreToolUse` matching `^create_goal$` -> `node "${PLUGIN_ROOT}/dist/cli.js" hook pre-tool-use`
  - `PreToolUse` matching the spawn tool tokens -> `node "${PLUGIN_ROOT}/dist/cli.js" hook pre-tool-use-spawn` (fan-out cap + gate-artifact preflight)
  - `Stop` -> `node "${PLUGIN_ROOT}/dist/cli.js" hook stop` (auto-resume with a two-strike no-progress cap)
- `skills/ulw-loop/` for the bundled `ulw-loop` skill.
- `directive.md`, the ultrawork directive read at runtime when `--with-ultrawork` falls back to the full text. This package is published standalone and takes no dependency on `@oh-my-opencode/prompts-core`, so it intentionally bundles its own byte-identical copy of the canonical `packages/prompts-core/prompts/ultrawork/codex.md`. The copy is generated by `components/ultrawork/scripts/sync-directive.mjs` and pinned byte-for-byte by `test/ultrawork-directive.test.ts`; do not hand-edit it.
- `bin.omo-ulw-loop` -> `dist/cli.js` for standalone CLI invocation.

This component ships a CLI, a skill, and hooks. It does not expose an MCP server.

## Local Development

```bash
npm install
npm test
npm run typecheck
npm run check
npm pack --dry-run
```

`npm test` runs Vitest, `npm run typecheck` runs `tsc --noEmit`, and `npm run check` runs typecheck, Biome, and the build.

## Local Codex Installation

```bash
npx lazycodex-ai install
```

The installer builds and copies the plugin into `~/.codex/plugins/cache/sisyphuslabs/omo/0.1.0`, registers the `sisyphuslabs` marketplace from the `lazycodex` Git repository, installs runtime dependencies there, and enables:

```toml
[features]
plugins = true
plugin_hooks = true

[plugins."omo@sisyphuslabs"]
enabled = true
```

## Privacy

This component runs locally and does not call a network service by itself.

## License

[MIT](LICENSE).

## Related

- [lazycodex](https://github.com/code-yeongyu/lazycodex) - Sisyphus Labs Codex marketplace repository.
- [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) - the monorepo this component is developed in.
