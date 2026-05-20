import argparse
import json
import math
import os
import random
import re
from typing import Dict, Iterable, List, Optional, Tuple

from run_external_benchmark import (
    find_primary_codex_seat,
    instantiate_agents,
    load_policy_weights,
    make_game,
    run_matchup,
)


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEARCH_REPLAY_SEED_PATTERN = re.compile(r"seed(\d+)")


def resolve_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(ROOT_DIR, path)


def load_json(path: str) -> Dict:
    with open(resolve_path(path), "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def iter_jsonl(path: str) -> Iterable[Dict]:
    with open(resolve_path(path), "r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def write_json(path: str, payload: Dict) -> None:
    resolved = resolve_path(path)
    os.makedirs(os.path.dirname(resolved), exist_ok=True)
    with open(resolved, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def append_jsonl(path: str, row: Dict) -> None:
    resolved = resolve_path(path)
    os.makedirs(os.path.dirname(resolved), exist_ok=True)
    with open(resolved, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def action_key(action: Dict) -> str:
    return json.dumps(action, sort_keys=True, separators=(",", ":"))


def prefix_key(prefix: List[Dict]) -> str:
    return json.dumps(prefix, sort_keys=True, separators=(",", ":"))


def extract_initial_keeps(best_replays_path: str) -> Dict[int, Dict]:
    payload = load_json(best_replays_path)
    seed_to_keep: Dict[int, Dict] = {}
    for replay in payload.get("replays", []):
        game_id = str(replay.get("gameId", ""))
        match = SEARCH_REPLAY_SEED_PATTERN.search(game_id)
        if not match:
            continue
        seed = int(match.group(1))
        for step in replay.get("steps", []):
            codex_decision = step.get("codexDecision")
            if not codex_decision:
                continue
            chosen_action = codex_decision.get("chosenAction")
            if isinstance(chosen_action, dict) and chosen_action.get("kind") == "keep-tickets":
                seed_to_keep[seed] = chosen_action
                break
        if seed not in seed_to_keep:
            raise RuntimeError(f"Could not find opening keep-tickets action in replay for seed {seed}.")
    return seed_to_keep


def load_preference_rows(
    preferences_path: str,
    initial_keeps: Dict[int, Dict],
    pair_limit: Optional[int] = None,
    min_confidence_weight: float = 0.0,
) -> List[Dict]:
    rows: List[Dict] = []
    for row in iter_jsonl(preferences_path):
        confidence_weight = float(row.get("confidenceWeight", 1.0))
        if confidence_weight < min_confidence_weight:
            continue
        seed = int(row["seed"])
        initial_keep = initial_keeps.get(seed)
        if not initial_keep:
            continue
        enriched = dict(row)
        enriched["openingKeepAction"] = initial_keep
        rows.append(enriched)
        if pair_limit is not None and len(rows) >= pair_limit:
            break
    return rows


def maybe_capture_recommendation(game, codex_agent, codex_seat: int, target_decision_index: int):
    if codex_agent.decision_counter != target_decision_index:
        return None
    codex_agent._ensure_observation_state(game, codex_seat)
    payload = codex_agent._build_payload(game, codex_seat)
    recommendation = codex_agent._request_solver_recommendation(payload)
    return {
        "payload": payload,
        "recommendation": recommendation,
    }


def capture_recommendation_for_prefix(
    seed: int,
    lineup: List[str],
    full_forced_prefix: List[Dict],
    policy_weights: Dict,
) -> Dict:
    random.seed(seed)
    game = make_game(len(lineup))
    agents = instantiate_agents(
        lineup,
        policy_weights=policy_weights,
        forced_action_prefix=full_forced_prefix,
        forced_action_start_index=0,
    )
    codex_seat = find_primary_codex_seat(lineup)
    if codex_seat is None:
        raise RuntimeError("Lineup must contain codex.")
    codex_agent = agents[codex_seat]
    target_decision_index = len(full_forced_prefix)
    codex_agents = [
        (seat_index, agent)
        for seat_index, agent in enumerate(agents)
        if hasattr(agent, "observe_move")
    ]

    for seat in range(game.number_of_players):
        capture = maybe_capture_recommendation(game, codex_agent, codex_seat, target_decision_index) if seat == codex_seat else None
        if capture is not None:
            return capture
        move = agents[seat].decide(game.copy(), seat)
        game.make_move(move.function, move.args)
        for observed_seat, observed_agent in codex_agents:
            observed_agent.observe_move(move, seat, observed_seat)

    while game.game_over is False:
        current_seat = game.current_player
        capture = (
            maybe_capture_recommendation(game, codex_agent, codex_seat, target_decision_index)
            if current_seat == codex_seat
            else None
        )
        if capture is not None:
            return capture
        move = agents[current_seat].decide(game, current_seat)
        game.make_move(move.function, move.args)
        for observed_seat, observed_agent in codex_agents:
            observed_agent.observe_move(move, current_seat, observed_seat)

    raise RuntimeError(
        f"Game ended before reaching target decision index {target_decision_index} for seed {seed}."
    )


def score_preference_rows(
    preference_rows: List[Dict],
    lineup: List[str],
    policy_weights: Dict,
    state_limit: Optional[int] = None,
    accuracy_weight: float = 1000.0,
    margin_weight: float = 1.0,
) -> Dict:
    state_cache: Dict[Tuple[int, str], Dict] = {}
    unique_state_count = 0
    resolved_rows = 0
    weighted_votes = 0.0
    weighted_correct = 0.0
    signed_margin_sum = 0.0

    for row in preference_rows:
        parent_prefix = list(row["parentPrefix"])
        full_prefix = [row["openingKeepAction"], *parent_prefix]
        state_key = (int(row["seed"]), prefix_key(full_prefix))
        if state_key not in state_cache:
            if state_limit is not None and unique_state_count >= state_limit:
                continue
            capture = capture_recommendation_for_prefix(
                seed=int(row["seed"]),
                lineup=lineup,
                full_forced_prefix=full_prefix,
                policy_weights=policy_weights,
            )
            action_scores = {
                action_key(alternative["action"]): float(alternative.get("utilityScore", 0.0))
                for alternative in capture["recommendation"].get("alternatives", [])
                if alternative.get("action")
            }
            state_cache[state_key] = action_scores
            unique_state_count += 1

        action_scores = state_cache[state_key]
        preferred_key = row["preferredActionKey"]
        rejected_key = row["rejectedActionKey"]
        if preferred_key not in action_scores or rejected_key not in action_scores:
            continue

        margin = float(action_scores[preferred_key]) - float(action_scores[rejected_key])
        weight = float(row.get("confidenceWeight", 1.0))
        resolved_rows += 1
        weighted_votes += weight
        signed_margin_sum += margin * weight
        if margin > 0:
            weighted_correct += weight
        elif margin == 0:
            weighted_correct += weight * 0.5

    weighted_accuracy = weighted_correct / weighted_votes if weighted_votes > 0 else 0.0
    average_signed_margin = signed_margin_sum / weighted_votes if weighted_votes > 0 else 0.0
    objective = weighted_accuracy * accuracy_weight + average_signed_margin * margin_weight
    return {
        "weightedAccuracy": weighted_accuracy,
        "averageSignedMargin": average_signed_margin,
        "objective": objective,
        "resolvedPairCount": resolved_rows,
        "uniqueStateCount": unique_state_count,
    }


def mutate_weights(base_weights: Dict, rng: random.Random, candidate_keys: List[str]) -> Dict:
    mutated = dict(base_weights)
    key_count = rng.randint(2, min(5, len(candidate_keys)))
    for key in rng.sample(candidate_keys, key_count):
        current = float(mutated[key])
        factor = rng.uniform(0.82, 1.22)
        mutated[key] = round(max(0.35, min(2.5, current * factor)), 4)
    return mutated


def compute_benchmark_objective(
    benchmark_summary: Dict,
    baseline_benchmark_summary: Dict,
    winrate_weight: float,
    score_weight: float,
    place_weight: float,
) -> Dict:
    winrate_delta = float(benchmark_summary["codexWinRate"]) - float(baseline_benchmark_summary["codexWinRate"])
    score_delta = float(benchmark_summary["codexAverageScore"]) - float(
        baseline_benchmark_summary["codexAverageScore"]
    )
    place_delta = float(benchmark_summary["codexAveragePlace"]) - float(
        baseline_benchmark_summary["codexAveragePlace"]
    )
    objective = (
        winrate_delta * winrate_weight
        + score_delta * score_weight
        - place_delta * place_weight
    )
    return {
        "objective": objective,
        "winRateDelta": winrate_delta,
        "scoreDelta": score_delta,
        "placeDelta": place_delta,
    }


def aggregate_benchmark_summaries(summaries: List[Dict]) -> Dict:
    if not summaries:
        raise RuntimeError("Expected at least one benchmark summary to aggregate.")

    games = sum(int(summary["games"]) for summary in summaries)
    weighted_win_rate = sum(float(summary["codexWinRate"]) * int(summary["games"]) for summary in summaries)
    weighted_score = sum(float(summary["codexAverageScore"]) * int(summary["games"]) for summary in summaries)
    weighted_place = sum(float(summary["codexAveragePlace"]) * int(summary["games"]) for summary in summaries)
    placement_counts = {str(place): 0 for place in range(1, 5)}
    for summary in summaries:
        for place, count in summary["codexPlacementCounts"].items():
            placement_counts[str(place)] += int(count)

    return {
        "games": games,
        "batchCount": len(summaries),
        "batches": summaries,
        "codexWinRate": weighted_win_rate / games if games > 0 else 0.0,
        "codexAverageScore": weighted_score / games if games > 0 else 0.0,
        "codexAveragePlace": weighted_place / games if games > 0 else 0.0,
        "codexPlacementCounts": placement_counts,
        "elapsedSeconds": sum(float(summary["elapsedSeconds"]) for summary in summaries),
    }


def evaluate_benchmark(
    lineup: List[str],
    games: int,
    seed_base: int,
    policy_weights: Dict,
    heuristic_weight: float,
    learned_weight: float,
) -> Dict:
    summary = run_matchup(
        lineup,
        games,
        seed_base,
        policy_weights=policy_weights,
        heuristic_weight=heuristic_weight,
        learned_weight=learned_weight,
        collect_training_rows=False,
    )
    return {
        "games": games,
        "seedBase": seed_base,
        "codexWinRate": summary["codexWinRate"],
        "codexAverageScore": summary["codexAverageScore"],
        "codexAveragePlace": summary["codexAveragePlace"],
        "codexPlacementCounts": summary["codexPlacementCounts"],
        "elapsedSeconds": summary["elapsedSeconds"],
    }


def evaluate_benchmark_batches(
    lineup: List[str],
    games: int,
    seed_base: int,
    batch_count: int,
    seed_step: int,
    policy_weights: Dict,
    heuristic_weight: float,
    learned_weight: float,
) -> Dict:
    batch_summaries = []
    for batch_index in range(batch_count):
        batch_seed_base = seed_base + batch_index * seed_step
        batch_summaries.append(
            evaluate_benchmark(
                lineup=lineup,
                games=games,
                seed_base=batch_seed_base,
                policy_weights=policy_weights,
                heuristic_weight=heuristic_weight,
                learned_weight=learned_weight,
            )
        )
    return aggregate_benchmark_summaries(batch_summaries)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Tune heuristic policy weights against search-derived pairwise preferences."
    )
    parser.add_argument("--preferences-jsonl", required=True)
    parser.add_argument("--best-replays-json", required=True)
    parser.add_argument("--base-weights", default="config/policy-weights.v1.0.5.json")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--iterations", type=int, default=12)
    parser.add_argument("--seed", type=int, default=41000)
    parser.add_argument("--pair-limit", type=int, default=None)
    parser.add_argument("--state-limit", type=int, default=None)
    parser.add_argument("--lineup", nargs="+", default=["codex", "osa", "lra", "path"])
    parser.add_argument(
        "--objective-mode",
        choices=["accuracy-first", "balanced", "margin-first"],
        default="accuracy-first",
    )
    parser.add_argument("--accuracy-weight", type=float, default=None)
    parser.add_argument("--margin-weight", type=float, default=None)
    parser.add_argument("--min-confidence-weight", type=float, default=0.0)
    parser.add_argument("--heuristic-weight", type=float, default=0.55)
    parser.add_argument("--learned-weight", type=float, default=0.45)
    parser.add_argument("--benchmark-games", type=int, default=0)
    parser.add_argument("--benchmark-seed-base", type=int, default=48000)
    parser.add_argument("--benchmark-batches", type=int, default=1)
    parser.add_argument("--benchmark-seed-step", type=int, default=1000)
    parser.add_argument(
        "--benchmark-eval-mode",
        choices=["promising", "all"],
        default="promising",
    )
    parser.add_argument(
        "--benchmark-trigger-delta",
        type=float,
        default=0.0,
        help="Evaluate benchmark only when preference objective beats the current best by at least this amount.",
    )
    parser.add_argument("--benchmark-winrate-weight", type=float, default=100.0)
    parser.add_argument("--benchmark-score-weight", type=float, default=1.0)
    parser.add_argument("--benchmark-place-weight", type=float, default=25.0)
    parser.add_argument("--benchmark-min-winrate-delta", type=float, default=0.0)
    parser.add_argument("--benchmark-min-score-delta", type=float, default=0.0)
    parser.add_argument("--benchmark-max-place-delta", type=float, default=0.0)
    args = parser.parse_args()

    output_dir = resolve_path(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    results_path = os.path.join(output_dir, "results.jsonl")
    if os.path.exists(results_path):
        os.remove(results_path)

    mode_defaults = {
        "accuracy-first": (1000.0, 1.0),
        "balanced": (100.0, 4.0),
        "margin-first": (25.0, 8.0),
    }
    default_accuracy_weight, default_margin_weight = mode_defaults[args.objective_mode]
    accuracy_weight = (
        args.accuracy_weight if args.accuracy_weight is not None else default_accuracy_weight
    )
    margin_weight = args.margin_weight if args.margin_weight is not None else default_margin_weight

    base_weights = load_policy_weights(args.base_weights)
    initial_keeps = extract_initial_keeps(args.best_replays_json)
    preference_rows = load_preference_rows(
        args.preferences_jsonl,
        initial_keeps,
        pair_limit=args.pair_limit,
        min_confidence_weight=args.min_confidence_weight,
    )

    candidate_keys = [
        "drawPenaltyScale",
        "claimBonusScale",
        "openingBlindBonusScale",
        "openingFaceUpTaxScale",
        "earlyLocomotiveTaxScale",
        "nonPriorityVisibleTaxScale",
        "sameTurnVisibleFollowThroughBonusScale",
        "sameTurnVisibleFollowThroughTaxScale",
        "ticketColorDemandScale",
        "ticketPathColorScale",
        "offTicketClaimPenaltyScale",
        "colorPriorityDemandScale",
        "colorPriorityPathScale",
        "colorPriorityCommittedScale",
        "colorPriorityVisibleScale",
        "ticketPathEfficiencyScale",
        "ticketPathBlockRiskScale",
        "ticketPathDrawChanceScale",
        "ticketPathReuseScale",
        "selfTrainPressureScale",
        "opponentTrainPressureScale",
    ]
    candidate_keys = [key for key in candidate_keys if key in base_weights]

    rng = random.Random(args.seed)
    best = None
    baseline_benchmark = None
    if args.benchmark_games > 0:
        baseline_benchmark = evaluate_benchmark_batches(
            lineup=args.lineup,
            games=args.benchmark_games,
            seed_base=args.benchmark_seed_base,
            batch_count=args.benchmark_batches,
            seed_step=args.benchmark_seed_step,
            policy_weights=base_weights,
            heuristic_weight=args.heuristic_weight,
            learned_weight=args.learned_weight,
        )
        print(
            "baseline benchmark "
            f"win_rate={baseline_benchmark['codexWinRate']:.3f} "
            f"avg_score={baseline_benchmark['codexAverageScore']:.2f} "
            f"avg_place={baseline_benchmark['codexAveragePlace']:.2f} "
            f"batches={baseline_benchmark['batchCount']} "
            f"elapsed={baseline_benchmark['elapsedSeconds']:.2f}s"
        )
    for run_index in range(args.iterations):
        weights = dict(base_weights) if run_index == 0 else mutate_weights(base_weights, rng, candidate_keys)
        metrics = score_preference_rows(
            preference_rows=preference_rows,
            lineup=args.lineup,
            policy_weights=weights,
            state_limit=args.state_limit,
            accuracy_weight=accuracy_weight,
            margin_weight=margin_weight,
        )
        row = {
            "runIndex": run_index,
            "weights": weights,
            "metrics": metrics,
        }
        benchmark_metrics = None
        benchmark_delta = None
        benchmark_pass = None
        hybrid_objective = metrics["objective"]
        should_evaluate_benchmark = False
        if baseline_benchmark is not None:
            if args.benchmark_eval_mode == "all":
                should_evaluate_benchmark = True
            else:
                best_pref_objective = best["metrics"]["objective"] if best is not None else float("-inf")
                should_evaluate_benchmark = metrics["objective"] >= (
                    best_pref_objective + args.benchmark_trigger_delta
                )
        if should_evaluate_benchmark and baseline_benchmark is not None:
            benchmark_metrics = evaluate_benchmark_batches(
                lineup=args.lineup,
                games=args.benchmark_games,
                seed_base=args.benchmark_seed_base,
                batch_count=args.benchmark_batches,
                seed_step=args.benchmark_seed_step,
                policy_weights=weights,
                heuristic_weight=args.heuristic_weight,
                learned_weight=args.learned_weight,
            )
            benchmark_delta = compute_benchmark_objective(
                benchmark_summary=benchmark_metrics,
                baseline_benchmark_summary=baseline_benchmark,
                winrate_weight=args.benchmark_winrate_weight,
                score_weight=args.benchmark_score_weight,
                place_weight=args.benchmark_place_weight,
            )
            benchmark_pass = (
                benchmark_delta["winRateDelta"] >= args.benchmark_min_winrate_delta
                and benchmark_delta["scoreDelta"] >= args.benchmark_min_score_delta
                and benchmark_delta["placeDelta"] <= args.benchmark_max_place_delta
            )
            hybrid_objective += benchmark_delta["objective"]
            row["benchmark"] = benchmark_metrics
            row["benchmarkDelta"] = benchmark_delta
            row["benchmarkPass"] = benchmark_pass
        row["metrics"]["hybridObjective"] = hybrid_objective
        append_jsonl(results_path, row)
        message = (
            f"run={run_index} objective={metrics['objective']:.3f} "
            f"accuracy={metrics['weightedAccuracy']:.3f} "
            f"margin={metrics['averageSignedMargin']:.3f} "
            f"pairs={metrics['resolvedPairCount']} states={metrics['uniqueStateCount']}"
        )
        if benchmark_delta is not None:
            message += (
                f" bench_win={benchmark_metrics['codexWinRate']:.3f}"
                f" bench_score={benchmark_metrics['codexAverageScore']:.2f}"
                f" bench_place={benchmark_metrics['codexAveragePlace']:.2f}"
                f" bench_pass={str(bool(benchmark_pass)).lower()}"
                f" hybrid={hybrid_objective:.3f}"
            )
        print(message)
        if baseline_benchmark is not None:
            if benchmark_delta is None or not benchmark_pass:
                selection_score = float("-inf")
            else:
                selection_score = hybrid_objective
        else:
            selection_score = metrics["objective"]
        best_selection_score = (
            best["metrics"].get("hybridObjective", best["metrics"]["objective"])
            if best is not None
            else float("-inf")
        )
        if best is None or selection_score > best_selection_score:
            best = row
            best["metrics"]["selectionObjective"] = selection_score
            print(
                f"new best -> run={run_index} objective={metrics['objective']:.3f} "
                f"accuracy={metrics['weightedAccuracy']:.3f} "
                f"selection={selection_score:.3f}"
            )

    if best is None:
        raise RuntimeError("No tuning runs completed.")

    summary = {
        "options": {
            "preferencesJsonl": args.preferences_jsonl,
            "bestReplaysJson": args.best_replays_json,
            "baseWeights": args.base_weights,
            "outputDir": args.output_dir,
            "iterations": args.iterations,
            "seed": args.seed,
            "pairLimit": args.pair_limit,
            "stateLimit": args.state_limit,
            "lineup": args.lineup,
            "objectiveMode": args.objective_mode,
            "accuracyWeight": accuracy_weight,
            "marginWeight": margin_weight,
            "minConfidenceWeight": args.min_confidence_weight,
            "heuristicWeight": args.heuristic_weight,
            "learnedWeight": args.learned_weight,
            "benchmarkGames": args.benchmark_games,
            "benchmarkSeedBase": args.benchmark_seed_base,
            "benchmarkBatches": args.benchmark_batches,
            "benchmarkSeedStep": args.benchmark_seed_step,
            "benchmarkEvalMode": args.benchmark_eval_mode,
            "benchmarkTriggerDelta": args.benchmark_trigger_delta,
            "benchmarkWinrateWeight": args.benchmark_winrate_weight,
            "benchmarkScoreWeight": args.benchmark_score_weight,
            "benchmarkPlaceWeight": args.benchmark_place_weight,
            "benchmarkMinWinrateDelta": args.benchmark_min_winrate_delta,
            "benchmarkMinScoreDelta": args.benchmark_min_score_delta,
            "benchmarkMaxPlaceDelta": args.benchmark_max_place_delta,
        },
        "baselineBenchmark": baseline_benchmark,
        "best": best,
    }
    write_json(os.path.join(output_dir, "best-weights.json"), best["weights"])
    write_json(os.path.join(output_dir, "summary.json"), summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
