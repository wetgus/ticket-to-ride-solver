import argparse
import json
import os
import random
from typing import Dict, List, Optional, Tuple

from run_external_benchmark import load_policy_weights
from tune_policy_weights_on_search_preferences import (
    compute_benchmark_objective,
    evaluate_benchmark_batches,
    extract_initial_keeps,
    load_preference_rows,
    resolve_path,
    score_preference_rows,
    write_json,
)


DEFAULT_CANDIDATE_KEYS = [
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


def append_jsonl(path: str, row: Dict) -> None:
    resolved = resolve_path(path)
    os.makedirs(os.path.dirname(resolved), exist_ok=True)
    with open(resolved, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def crossover_weights(parent_a: Dict, parent_b: Dict, rng: random.Random, candidate_keys: List[str]) -> Dict:
    child = dict(parent_a)
    swap_count = rng.randint(2, min(6, len(candidate_keys)))
    for key in rng.sample(candidate_keys, swap_count):
        value_a = float(parent_a[key])
        value_b = float(parent_b[key])
        if rng.random() < 0.5:
            child[key] = round(value_b, 4)
        else:
            mix = rng.uniform(0.35, 0.65)
            child[key] = round(value_a * mix + value_b * (1.0 - mix), 4)
    return child


def mutate_weights(weights: Dict, rng: random.Random, candidate_keys: List[str], mutation_scale: float) -> Dict:
    mutated = dict(weights)
    key_count = rng.randint(2, min(6, len(candidate_keys)))
    for key in rng.sample(candidate_keys, key_count):
        current = float(mutated[key])
        factor = rng.uniform(1.0 - mutation_scale, 1.0 + mutation_scale)
        mutated[key] = round(max(0.35, min(2.5, current * factor)), 4)
    return mutated


def make_random_candidate(
    base_weights: Dict,
    rng: random.Random,
    candidate_keys: List[str],
    mutation_scale: float,
) -> Dict:
    return mutate_weights(base_weights, rng, candidate_keys, mutation_scale)


def evaluate_candidate(
    weights: Dict,
    preference_rows: List[Dict],
    lineup: List[str],
    state_limit: Optional[int],
    accuracy_weight: float,
    margin_weight: float,
    baseline_benchmark: Optional[Dict],
    benchmark_games: int,
    benchmark_seed_base: int,
    benchmark_batches: int,
    benchmark_seed_step: int,
    heuristic_weight: float,
    learned_weight: float,
    benchmark_winrate_weight: float,
    benchmark_score_weight: float,
    benchmark_place_weight: float,
    benchmark_min_winrate_delta: float,
    benchmark_min_score_delta: float,
    benchmark_max_place_delta: float,
) -> Dict:
    metrics = score_preference_rows(
        preference_rows=preference_rows,
        lineup=lineup,
        policy_weights=weights,
        state_limit=state_limit,
        accuracy_weight=accuracy_weight,
        margin_weight=margin_weight,
    )
    row = {
        "weights": weights,
        "metrics": metrics,
    }

    selection_objective = metrics["objective"]
    if baseline_benchmark is not None and benchmark_games > 0:
        benchmark = evaluate_benchmark_batches(
            lineup=lineup,
            games=benchmark_games,
            seed_base=benchmark_seed_base,
            batch_count=benchmark_batches,
            seed_step=benchmark_seed_step,
            policy_weights=weights,
            heuristic_weight=heuristic_weight,
            learned_weight=learned_weight,
        )
        benchmark_delta = compute_benchmark_objective(
            benchmark_summary=benchmark,
            baseline_benchmark_summary=baseline_benchmark,
            winrate_weight=benchmark_winrate_weight,
            score_weight=benchmark_score_weight,
            place_weight=benchmark_place_weight,
        )
        benchmark_pass = (
            benchmark_delta["winRateDelta"] >= benchmark_min_winrate_delta
            and benchmark_delta["scoreDelta"] >= benchmark_min_score_delta
            and benchmark_delta["placeDelta"] <= benchmark_max_place_delta
        )
        row["benchmark"] = benchmark
        row["benchmarkDelta"] = benchmark_delta
        row["benchmarkPass"] = benchmark_pass
        if benchmark_pass:
            selection_objective = metrics["objective"] + benchmark_delta["objective"]
        else:
            selection_objective = float("-inf")

    row["metrics"]["selectionObjective"] = selection_objective
    return row


def summarize_generation(generation_index: int, population_rows: List[Dict]) -> Dict:
    ordered = sorted(
        population_rows,
        key=lambda row: row["metrics"]["selectionObjective"],
        reverse=True,
    )
    best = ordered[0]
    passed = sum(1 for row in population_rows if row.get("benchmarkPass") is True)
    return {
        "generation": generation_index,
        "populationSize": len(population_rows),
        "passedBenchmarkCount": passed,
        "bestSelectionObjective": best["metrics"]["selectionObjective"],
        "bestPreferenceObjective": best["metrics"]["objective"],
        "bestAccuracy": best["metrics"]["weightedAccuracy"],
        "bestMargin": best["metrics"]["averageSignedMargin"],
        "bestBenchmarkDelta": best.get("benchmarkDelta"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evolve policy weights with preference fitness plus hybrid benchmark gating."
    )
    parser.add_argument("--preferences-jsonl", required=True)
    parser.add_argument("--best-replays-json", required=True)
    parser.add_argument("--base-weights", default="config/policy-weights.v1.0.5.json")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=48050)
    parser.add_argument("--population-size", type=int, default=16)
    parser.add_argument("--generations", type=int, default=6)
    parser.add_argument("--elite-count", type=int, default=3)
    parser.add_argument("--random-inject-count", type=int, default=2)
    parser.add_argument("--mutation-scale", type=float, default=0.18)
    parser.add_argument("--pair-limit", type=int, default=None)
    parser.add_argument("--state-limit", type=int, default=None)
    parser.add_argument("--lineup", nargs="+", default=["codex", "osa", "lra", "path"])
    parser.add_argument("--min-confidence-weight", type=float, default=0.2)
    parser.add_argument("--accuracy-weight", type=float, default=1000.0)
    parser.add_argument("--margin-weight", type=float, default=1.0)
    parser.add_argument("--heuristic-weight", type=float, default=0.55)
    parser.add_argument("--learned-weight", type=float, default=0.45)
    parser.add_argument("--benchmark-games", type=int, default=6)
    parser.add_argument("--benchmark-seed-base", type=int, default=56000)
    parser.add_argument("--benchmark-batches", type=int, default=2)
    parser.add_argument("--benchmark-seed-step", type=int, default=1000)
    parser.add_argument("--benchmark-winrate-weight", type=float, default=100.0)
    parser.add_argument("--benchmark-score-weight", type=float, default=1.0)
    parser.add_argument("--benchmark-place-weight", type=float, default=25.0)
    parser.add_argument("--benchmark-min-winrate-delta", type=float, default=0.05)
    parser.add_argument("--benchmark-min-score-delta", type=float, default=0.5)
    parser.add_argument("--benchmark-max-place-delta", type=float, default=-0.01)
    args = parser.parse_args()

    output_dir = resolve_path(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    results_path = os.path.join(output_dir, "results.jsonl")
    if os.path.exists(results_path):
        os.remove(results_path)

    base_weights = load_policy_weights(args.base_weights)
    initial_keeps = extract_initial_keeps(args.best_replays_json)
    preference_rows = load_preference_rows(
        args.preferences_jsonl,
        initial_keeps,
        pair_limit=args.pair_limit,
        min_confidence_weight=args.min_confidence_weight,
    )
    candidate_keys = [key for key in DEFAULT_CANDIDATE_KEYS if key in base_weights]
    rng = random.Random(args.seed)

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

    population_weights: List[Dict] = [dict(base_weights)]
    while len(population_weights) < args.population_size:
        population_weights.append(
            make_random_candidate(
                base_weights=base_weights,
                rng=rng,
                candidate_keys=candidate_keys,
                mutation_scale=args.mutation_scale,
            )
        )

    best_overall = None
    generation_summaries = []
    for generation_index in range(args.generations):
        population_rows = []
        for member_index, weights in enumerate(population_weights):
            row = evaluate_candidate(
                weights=weights,
                preference_rows=preference_rows,
                lineup=args.lineup,
                state_limit=args.state_limit,
                accuracy_weight=args.accuracy_weight,
                margin_weight=args.margin_weight,
                baseline_benchmark=baseline_benchmark,
                benchmark_games=args.benchmark_games,
                benchmark_seed_base=args.benchmark_seed_base,
                benchmark_batches=args.benchmark_batches,
                benchmark_seed_step=args.benchmark_seed_step,
                heuristic_weight=args.heuristic_weight,
                learned_weight=args.learned_weight,
                benchmark_winrate_weight=args.benchmark_winrate_weight,
                benchmark_score_weight=args.benchmark_score_weight,
                benchmark_place_weight=args.benchmark_place_weight,
                benchmark_min_winrate_delta=args.benchmark_min_winrate_delta,
                benchmark_min_score_delta=args.benchmark_min_score_delta,
                benchmark_max_place_delta=args.benchmark_max_place_delta,
            )
            row["generation"] = generation_index
            row["memberIndex"] = member_index
            append_jsonl(results_path, row)
            population_rows.append(row)
            print(
                f"gen={generation_index} member={member_index} "
                f"selection={row['metrics']['selectionObjective']:.3f} "
                f"pref={row['metrics']['objective']:.3f} "
                f"acc={row['metrics']['weightedAccuracy']:.3f} "
                f"margin={row['metrics']['averageSignedMargin']:.3f}"
            )

        population_rows.sort(key=lambda row: row["metrics"]["selectionObjective"], reverse=True)
        if best_overall is None or (
            population_rows[0]["metrics"]["selectionObjective"] > best_overall["metrics"]["selectionObjective"]
        ):
            best_overall = population_rows[0]
            print(
                f"new overall best -> gen={generation_index} "
                f"selection={best_overall['metrics']['selectionObjective']:.3f}"
            )

        generation_summary = summarize_generation(generation_index, population_rows)
        generation_summaries.append(generation_summary)
        print(
            f"generation={generation_index} best_selection={generation_summary['bestSelectionObjective']:.3f} "
            f"passed={generation_summary['passedBenchmarkCount']}/{generation_summary['populationSize']}"
        )

        elites = population_rows[: args.elite_count]
        parent_pool = [row for row in population_rows if row["metrics"]["selectionObjective"] != float("-inf")]
        if len(parent_pool) < 2:
            parent_pool = elites

        next_population = [dict(row["weights"]) for row in elites]
        while len(next_population) < max(args.population_size - args.random_inject_count, args.elite_count):
            parent_a, parent_b = rng.sample(parent_pool, 2) if len(parent_pool) >= 2 else (elites[0], elites[0])
            child = crossover_weights(parent_a["weights"], parent_b["weights"], rng, candidate_keys)
            child = mutate_weights(child, rng, candidate_keys, args.mutation_scale)
            next_population.append(child)
        while len(next_population) < args.population_size:
            next_population.append(
                make_random_candidate(
                    base_weights=base_weights,
                    rng=rng,
                    candidate_keys=candidate_keys,
                    mutation_scale=args.mutation_scale,
                )
            )
        population_weights = next_population[: args.population_size]

    if best_overall is None:
        raise RuntimeError("Evolution finished without any evaluated candidates.")

    summary = {
        "options": {
            "preferencesJsonl": args.preferences_jsonl,
            "bestReplaysJson": args.best_replays_json,
            "baseWeights": args.base_weights,
            "outputDir": args.output_dir,
            "seed": args.seed,
            "populationSize": args.population_size,
            "generations": args.generations,
            "eliteCount": args.elite_count,
            "randomInjectCount": args.random_inject_count,
            "mutationScale": args.mutation_scale,
            "pairLimit": args.pair_limit,
            "stateLimit": args.state_limit,
            "lineup": args.lineup,
            "minConfidenceWeight": args.min_confidence_weight,
            "accuracyWeight": args.accuracy_weight,
            "marginWeight": args.margin_weight,
            "heuristicWeight": args.heuristic_weight,
            "learnedWeight": args.learned_weight,
            "benchmarkGames": args.benchmark_games,
            "benchmarkSeedBase": args.benchmark_seed_base,
            "benchmarkBatches": args.benchmark_batches,
            "benchmarkSeedStep": args.benchmark_seed_step,
            "benchmarkWinrateWeight": args.benchmark_winrate_weight,
            "benchmarkScoreWeight": args.benchmark_score_weight,
            "benchmarkPlaceWeight": args.benchmark_place_weight,
            "benchmarkMinWinrateDelta": args.benchmark_min_winrate_delta,
            "benchmarkMinScoreDelta": args.benchmark_min_score_delta,
            "benchmarkMaxPlaceDelta": args.benchmark_max_place_delta,
        },
        "baselineBenchmark": baseline_benchmark,
        "generationSummaries": generation_summaries,
        "best": best_overall,
    }
    write_json(os.path.join(output_dir, "best-weights.json"), best_overall["weights"])
    write_json(os.path.join(output_dir, "summary.json"), summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
