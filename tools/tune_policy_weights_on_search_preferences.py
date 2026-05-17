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
) -> List[Dict]:
    rows: List[Dict] = []
    for row in iter_jsonl(preferences_path):
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
    objective = weighted_accuracy * 100.0 + average_signed_margin * 4.0
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
    args = parser.parse_args()

    output_dir = resolve_path(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    results_path = os.path.join(output_dir, "results.jsonl")
    if os.path.exists(results_path):
        os.remove(results_path)

    base_weights = load_policy_weights(args.base_weights)
    initial_keeps = extract_initial_keeps(args.best_replays_json)
    preference_rows = load_preference_rows(args.preferences_jsonl, initial_keeps, pair_limit=args.pair_limit)

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
    for run_index in range(args.iterations):
        weights = dict(base_weights) if run_index == 0 else mutate_weights(base_weights, rng, candidate_keys)
        metrics = score_preference_rows(
            preference_rows=preference_rows,
            lineup=args.lineup,
            policy_weights=weights,
            state_limit=args.state_limit,
        )
        row = {
            "runIndex": run_index,
            "weights": weights,
            "metrics": metrics,
        }
        append_jsonl(results_path, row)
        print(
            f"run={run_index} objective={metrics['objective']:.3f} "
            f"accuracy={metrics['weightedAccuracy']:.3f} "
            f"margin={metrics['averageSignedMargin']:.3f} "
            f"pairs={metrics['resolvedPairCount']} states={metrics['uniqueStateCount']}"
        )
        if best is None or metrics["objective"] > best["metrics"]["objective"]:
            best = row
            print(
                f"new best -> run={run_index} objective={metrics['objective']:.3f} "
                f"accuracy={metrics['weightedAccuracy']:.3f}"
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
        },
        "best": best,
    }
    write_json(os.path.join(output_dir, "best-weights.json"), best["weights"])
    write_json(os.path.join(output_dir, "summary.json"), summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
