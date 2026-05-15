import argparse
import copy
import json
import os
import random
import time
from typing import Dict, List, Optional, Tuple

from run_external_benchmark import (
    ROOT_DIR,
    find_primary_codex_seat,
    instantiate_agents,
    load_policy_weights,
    make_game,
    play_game_with_trace,
)


def write_json(path: str, payload: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def append_jsonl(path: str, row: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def prefix_key(prefix: List[Dict]) -> str:
    return json.dumps(prefix, sort_keys=True, separators=(",", ":"))


def build_objective(score: int, place: int) -> float:
    win_bonus = 18.0 if place == 1 else 0.0
    podium_bonus = 4.0 if place <= 2 else 0.0
    return float(score) - float(place - 1) * 11.0 + win_bonus + podium_bonus


def select_branch_actions(trace_step: Dict, branch_factor: int) -> List[Dict]:
    actions: List[Dict] = []
    seen = set()
    for alternative in trace_step.get("alternatives", []):
        action = alternative.get("action")
        if not action:
            continue
        key = prefix_key([action])
        if key in seen:
            continue
        seen.add(key)
        actions.append(copy.deepcopy(action))
        if len(actions) >= branch_factor:
            break
    return actions


def annotate_forced_decisions(
    trace_steps: List[Dict],
    forced_prefix: List[Dict],
    start_index: int,
) -> List[Dict]:
    annotated: List[Dict] = []
    for offset, action in enumerate(forced_prefix):
        decision_index = start_index + offset
        trace_step = trace_steps[decision_index] if decision_index < len(trace_steps) else None
        annotated.append(
            {
                "decisionIndex": decision_index,
                "phase": trace_step.get("phase") if trace_step else None,
                "action": copy.deepcopy(action),
            }
        )
    return annotated


def extract_codex_result(game, lineup: List[str]) -> Tuple[int, int]:
    ordered = sorted(
        [(index, player.points) for index, player in enumerate(game.players)],
        key=lambda item: item[1],
        reverse=True,
    )
    placements = {player_index: place for place, (player_index, _) in enumerate(ordered, start=1)}
    codex_seat = find_primary_codex_seat(lineup)
    if codex_seat is None:
        raise RuntimeError("Lineup does not contain codex.")
    return int(game.players[codex_seat].points), int(placements[codex_seat])


def run_prefix_rollout(
    seed: int,
    lineup: List[str],
    forced_prefix: List[Dict],
    forced_action_start_index: int,
    policy_model_path: Optional[str],
    policy_weights: Optional[Dict],
    heuristic_weight: float,
    learned_weight: float,
    collect_replay: bool = False,
) -> Dict:
    random.seed(seed)
    game = make_game(len(lineup))
    agents = instantiate_agents(
        lineup,
        policy_model_path=policy_model_path,
        policy_weights=policy_weights,
        forced_action_prefix=forced_prefix,
        forced_action_start_index=forced_action_start_index,
        heuristic_weight=heuristic_weight,
        learned_weight=learned_weight,
    )

    replay = play_game_with_trace(
        game,
        agents,
        lineup,
        f"{'-'.join(lineup)}-seed{seed}",
        collect_replay=collect_replay,
    )

    score, place = extract_codex_result(game, lineup)
    codex_seat = find_primary_codex_seat(lineup)
    codex_trace = getattr(agents[codex_seat], "trace_steps", []) if codex_seat is not None else []
    return {
        "score": score,
        "place": place,
        "objective": build_objective(score, place),
        "traceSteps": codex_trace,
        "replay": replay,
        "turnCount": len(replay["steps"]) if replay is not None else None,
    }


def estimate_rollouts_per_seed(depth: int, beam_width: int, branch_factor: int) -> int:
    if depth <= 0:
        return 1
    return 1 + branch_factor + max(0, depth - 1) * beam_width * branch_factor


def search_seed(
    seed: int,
    lineup: List[str],
    depth: int,
    beam_width: int,
    branch_factor: int,
    skip_codex_decisions: int,
    policy_model_path: Optional[str],
    policy_weights: Optional[Dict],
    heuristic_weight: float,
    learned_weight: float,
    results_jsonl_path: Optional[str],
) -> Dict:
    cache: Dict[str, Dict] = {}
    frontier: List[List[Dict]] = [[]]
    visited: List[Dict] = []

    def evaluate(prefix: List[Dict]) -> Dict:
        key = prefix_key(prefix)
        if key in cache:
            return cache[key]
        started_at = time.time()
        rollout = run_prefix_rollout(
            seed=seed,
            lineup=lineup,
            forced_prefix=prefix,
            forced_action_start_index=skip_codex_decisions,
            policy_model_path=policy_model_path,
            policy_weights=policy_weights,
            heuristic_weight=heuristic_weight,
            learned_weight=learned_weight,
            collect_replay=False,
        )
        record = {
            "seed": seed,
            "prefixLength": len(prefix),
            "forcedPrefix": copy.deepcopy(prefix),
            "forcedDecisions": annotate_forced_decisions(
                rollout["traceSteps"],
                prefix,
                skip_codex_decisions,
            ),
            "score": rollout["score"],
            "place": rollout["place"],
            "objective": rollout["objective"],
            "turnCount": rollout["turnCount"],
            "elapsedSeconds": round(time.time() - started_at, 2),
            "traceStepCount": len(rollout["traceSteps"]),
        }
        cache[key] = {"rollout": rollout, "record": record}
        visited.append(record)
        if results_jsonl_path:
            append_jsonl(results_jsonl_path, record)
        return cache[key]

    evaluate([])

    for depth_index in range(depth):
        branch_pool: List[Tuple[List[Dict], Dict]] = []
        for prefix in frontier:
            node = evaluate(prefix)
            trace_steps = node["rollout"]["traceSteps"]
            target_decision_index = skip_codex_decisions + len(prefix)
            if len(trace_steps) <= target_decision_index:
                continue

            branch_actions = select_branch_actions(trace_steps[target_decision_index], branch_factor)
            for action in branch_actions:
                child_prefix = copy.deepcopy(prefix)
                child_prefix.append(action)
                child_node = evaluate(child_prefix)
                branch_pool.append((child_prefix, child_node["record"]))

        if not branch_pool:
            break

        branch_pool.sort(
            key=lambda item: (
                item[1]["objective"],
                item[1]["score"],
                -item[1]["place"],
            ),
            reverse=True,
        )
        frontier = [copy.deepcopy(prefix) for prefix, _record in branch_pool[:beam_width]]

    best_record = max(
        visited,
        key=lambda record: (
            record["objective"],
            record["score"],
            -record["place"],
        ),
    )
    best_rollout = run_prefix_rollout(
        seed=seed,
        lineup=lineup,
        forced_prefix=best_record["forcedPrefix"],
        forced_action_start_index=skip_codex_decisions,
        policy_model_path=policy_model_path,
        policy_weights=policy_weights,
        heuristic_weight=heuristic_weight,
        learned_weight=learned_weight,
        collect_replay=True,
    )

    top_records = sorted(
        visited,
        key=lambda record: (
            record["objective"],
            record["score"],
            -record["place"],
        ),
        reverse=True,
    )[:beam_width]

    return {
        "seed": seed,
        "best": {
            "forcedActionStartIndex": skip_codex_decisions,
            "forcedPrefix": best_record["forcedPrefix"],
            "forcedDecisions": annotate_forced_decisions(
                best_rollout["traceSteps"],
                best_record["forcedPrefix"],
                skip_codex_decisions,
            ),
            "score": best_rollout["score"],
            "place": best_rollout["place"],
            "objective": best_rollout["objective"],
            "turnCount": best_rollout["turnCount"],
        },
        "topCandidates": top_records,
        "evaluatedPrefixCount": len(visited),
        "bestReplay": best_rollout["replay"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Beam-search over early Codex decisions, with baseline rollouts after the forced prefix."
    )
    parser.add_argument("--games", type=int, default=4, help="How many seeded games to search.")
    parser.add_argument("--seed-base", type=int, default=35000)
    parser.add_argument("--lineup", nargs="+", default=["codex", "osa", "lra", "path"])
    parser.add_argument("--beam-width", type=int, default=4, help="How many best prefixes survive each depth.")
    parser.add_argument("--branch-factor", type=int, default=4, help="How many actions to branch from each node.")
    parser.add_argument("--depth", type=int, default=3, help="How many Codex decisions to force before rollout.")
    parser.add_argument(
        "--skip-codex-decisions",
        type=int,
        default=1,
        help="How many initial Codex decisions to leave to baseline before branching. Use 1 to skip the opening ticket keep.",
    )
    parser.add_argument("--policy-model", default=None)
    parser.add_argument("--policy-weights-json", default="config/policy-weights.v1.0.5.json")
    parser.add_argument("--heuristic-weight", type=float, default=0.55)
    parser.add_argument("--learned-weight", type=float, default=0.45)
    parser.add_argument("--output-json", default="artifacts/prefix-search-summary.json")
    parser.add_argument("--output-jsonl", default="artifacts/prefix-search-results.jsonl")
    parser.add_argument(
        "--export-best-replays-json",
        default="artifacts/prefix-search-best-replays.json",
        help="Optional JSON file containing replays for the best prefix found per seed.",
    )
    args = parser.parse_args()

    if "codex" not in args.lineup:
        raise SystemExit("Lineup must include 'codex'.")

    output_json = os.path.join(ROOT_DIR, args.output_json)
    output_jsonl = os.path.join(ROOT_DIR, args.output_jsonl)
    best_replays_path = (
        os.path.join(ROOT_DIR, args.export_best_replays_json)
        if args.export_best_replays_json
        else None
    )
    if os.path.exists(output_jsonl):
        os.remove(output_jsonl)

    policy_weights = load_policy_weights(args.policy_weights_json)
    estimated_per_seed = estimate_rollouts_per_seed(args.depth, args.beam_width, args.branch_factor)
    estimated_total = estimated_per_seed * args.games

    print(
        "prefix-search config:",
        f"games={args.games}",
        f"beam_width={args.beam_width}",
        f"branch_factor={args.branch_factor}",
        f"depth={args.depth}",
        f"skip_codex_decisions={args.skip_codex_decisions}",
        f"estimated_rollouts_per_seed={estimated_per_seed}",
        f"estimated_total_rollouts={estimated_total}",
    )

    started_at = time.time()
    per_seed = []
    replays = []
    for offset in range(args.games):
        seed = args.seed_base + offset
        seed_started_at = time.time()
        result = search_seed(
            seed=seed,
            lineup=args.lineup,
            depth=args.depth,
            beam_width=args.beam_width,
            branch_factor=args.branch_factor,
            skip_codex_decisions=args.skip_codex_decisions,
            policy_model_path=args.policy_model,
            policy_weights=policy_weights,
            heuristic_weight=args.heuristic_weight,
            learned_weight=args.learned_weight,
            results_jsonl_path=output_jsonl,
        )
        per_seed.append(
            {
                "seed": result["seed"],
                "best": result["best"],
                "topCandidates": result["topCandidates"],
                "evaluatedPrefixCount": result["evaluatedPrefixCount"],
                "elapsedSeconds": round(time.time() - seed_started_at, 2),
            }
        )
        if result["bestReplay"] is not None:
            replays.append(result["bestReplay"])
        print(
            f"seed={seed} best_place={result['best']['place']} best_score={result['best']['score']} "
            f"best_objective={result['best']['objective']:.2f} evaluated_prefixes={result['evaluatedPrefixCount']} "
            f"elapsed={round(time.time() - seed_started_at, 2)}s"
        )

    summary = {
        "options": {
            "games": args.games,
            "seedBase": args.seed_base,
            "lineup": args.lineup,
            "beamWidth": args.beam_width,
            "branchFactor": args.branch_factor,
            "depth": args.depth,
            "skipCodexDecisions": args.skip_codex_decisions,
            "policyModel": args.policy_model,
            "policyWeightsJson": args.policy_weights_json,
            "heuristicWeight": args.heuristic_weight,
            "learnedWeight": args.learned_weight,
            "estimatedRolloutsPerSeed": estimated_per_seed,
            "estimatedTotalRollouts": estimated_total,
        },
        "perSeed": per_seed,
        "bestReplaysPath": args.export_best_replays_json,
        "elapsedSeconds": round(time.time() - started_at, 2),
    }
    write_json(output_json, summary)
    if best_replays_path:
        write_json(best_replays_path, {"replays": replays})
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
