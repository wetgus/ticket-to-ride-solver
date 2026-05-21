import argparse
import copy
import json
import os
import random
import re
from typing import Dict, List, Optional, Tuple

from external_engine_codex_agent import CodexSolverAgent, normalize_city, normalize_color, ticket_id_for_card
from run_external_benchmark import (
    find_primary_codex_seat,
    instantiate_agents,
    load_policy_weights,
    make_game,
)


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_PATTERN = re.compile(r"seed(\d+)")


def resolve_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(ROOT_DIR, path)


def load_json(path: str) -> Dict:
    with open(resolve_path(path), "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


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


def extract_seed(game_id: str) -> int:
    match = SEED_PATTERN.search(game_id)
    if not match:
        raise RuntimeError(f"Could not infer seed from game id: {game_id}")
    return int(match.group(1))


def find_replay(payload: Dict, seed: Optional[int], game_id: Optional[str]) -> Dict:
    for replay in payload.get("replays", []):
        if game_id and replay.get("gameId") == game_id:
            return replay
        if seed is not None and extract_seed(str(replay.get("gameId", ""))) == seed:
            return replay
    raise RuntimeError("Requested replay was not found.")


def extract_codex_actions(replay: Dict) -> List[Dict]:
    actions = []
    for step in replay.get("steps", []):
        codex_decision = step.get("codexDecision")
        if not codex_decision:
            continue
        chosen_action = codex_decision.get("chosenAction")
        if chosen_action:
            actions.append(chosen_action)
    return actions


def summarize_replay_baseline(replay: Dict) -> Dict:
    final_scores = replay.get("finalScores", [])
    codex_row = next((row for row in final_scores if int(row["seat"]) == int(replay["codexSeat"])), None)
    if codex_row is None:
        raise RuntimeError("Replay is missing final Codex score.")
    ordered = sorted(
        [(int(row["seat"]), int(row["score"])) for row in final_scores],
        key=lambda item: item[1],
        reverse=True,
    )
    placement_map = {}
    for place, (seat, _) in enumerate(ordered, start=1):
        placement_map[seat] = place
    return {
        "score": int(codex_row["score"]),
        "place": int(placement_map[int(replay["codexSeat"])]),
        "finalScores": final_scores,
    }


def observe_all(agents: List[object], move, actor_seat: int) -> None:
    for observed_seat, agent in enumerate(agents):
        if hasattr(agent, "observe_move"):
            agent.observe_move(move, actor_seat, observed_seat)


def continue_until_game_over(game, agents: List[object]) -> Dict:
    while not game.game_over:
        current_seat = game.current_player
        move = agents[current_seat].decide(game, current_seat)
        game.make_move(move.function, move.args)
        observe_all(agents, move, current_seat)
    return summarize_final_state(game)


def summarize_final_state(game) -> Dict:
    ordered = sorted(
        [(index, player.points) for index, player in enumerate(game.players)],
        key=lambda item: item[1],
        reverse=True,
    )
    placements = {}
    for place, (player_index, _) in enumerate(ordered, start=1):
        placements[player_index] = place
    codex_score = int(game.players[0].points)
    codex_place = int(placements[0])
    return {
        "score": codex_score,
        "place": codex_place,
        "finalScores": [
            {
                "seat": index,
                "score": int(game.players[index].points),
                "place": int(placements[index]),
            }
            for index in range(game.number_of_players)
        ],
    }


def replay_step_to_move(game, actor_seat: int, step: Dict):
    move_payload = step["move"]
    possible_moves = game.get_possible_moves(actor_seat)
    kind = move_payload.get("kind")

    if kind == "draw-train-hidden":
        for move in possible_moves:
            if move.function == "drawTrainCard" and str(move.args).lower() == "top":
                return move

    if kind == "draw-train-face-up":
        target_color = move_payload.get("color")
        for move in possible_moves:
            if move.function != "drawTrainCard" or str(move.args).lower() == "top":
                continue
            if normalize_color(str(move.args)) == target_color:
                return move

    if kind == "draw-destination-tickets":
        for move in possible_moves:
            if move.function == "drawDestinationCards":
                return move

    if kind == "keep-destination-tickets":
        target_ticket_ids = sorted(move_payload.get("keptTicketIds", []))
        for move in possible_moves:
            if move.function != "chooseDestinationCards":
                continue
            move_ticket_ids = sorted(ticket_id_for_card(card) for card in move.args[1])
            if move_ticket_ids == target_ticket_ids:
                return move

    if kind == "claim-route":
        target_pair = sorted((move_payload["cityA"], move_payload["cityB"]))
        target_color = move_payload["color"]
        for move in possible_moves:
            if move.function != "claimRoute":
                continue
            move_pair = sorted((normalize_city(move.args[0]), normalize_city(move.args[1])))
            if move_pair != target_pair:
                continue
            if normalize_color(str(move.args[2])) == target_color:
                return move

    raise RuntimeError(
        f"Could not replay step {step.get('index')} for seat {actor_seat}: "
        f"{json.dumps(move_payload, ensure_ascii=True)}"
    )


def apply_replay_step(game, agents: List[object], step: Dict, codex_seat: int) -> None:
    actor_seat = int(step["actorSeat"])
    move = replay_step_to_move(game, actor_seat, step)
    game.make_move(move.function, move.args)
    observe_all(agents, move, actor_seat)

    if actor_seat == codex_seat and step.get("codexDecision"):
        codex_agent = agents[codex_seat]
        chosen_action = step["codexDecision"].get("chosenAction")
        if chosen_action:
            codex_agent._record_turn_draw_context(chosen_action)
        codex_agent.decision_counter += 1


def run_to_codex_frontier(
    seed: int,
    lineup: List[str],
    replay: Dict,
    suffix_start_decision_index: int,
    forced_actions: List[Dict],
    frontier_decision_index: int,
    policy_weights: Optional[Dict],
    heuristic_weight: float,
    learned_weight: float,
) -> Tuple[object, List[object], Optional[int], bool]:
    random.seed(seed)
    game = make_game(len(lineup))
    agents = instantiate_agents(
        lineup,
        policy_weights=policy_weights,
        forced_action_prefix=forced_actions,
        forced_action_start_index=suffix_start_decision_index,
        heuristic_weight=heuristic_weight,
        learned_weight=learned_weight,
    )
    codex_seat = find_primary_codex_seat(lineup)
    if codex_seat is None:
        raise RuntimeError("Lineup must contain codex.")
    codex_agent = agents[codex_seat]

    for step in replay.get("steps", []):
        if int(step["actorSeat"]) == codex_seat and step.get("codexDecision"):
            if codex_agent.decision_counter == suffix_start_decision_index:
                break
        apply_replay_step(game, agents, step, codex_seat)

    while not game.game_over:
        current_seat = game.current_player
        if current_seat == codex_seat and codex_agent.decision_counter == frontier_decision_index:
            return game, agents, codex_seat, True
        move = agents[current_seat].decide(game, current_seat)
        game.make_move(move.function, move.args)
        observe_all(agents, move, current_seat)

    return game, agents, codex_seat, False


def get_legal_alternatives(game, codex_agent: CodexSolverAgent, codex_seat: int, top_k: int) -> List[Dict]:
    codex_agent._ensure_observation_state(game, codex_seat)
    payload = codex_agent._build_payload(game, codex_seat)
    recommendation = codex_agent._request_solver_recommendation(payload)
    possible_moves = game.get_possible_moves(codex_seat)

    unique_actions = []
    seen = set()
    for alternative in recommendation.get("alternatives", []):
        action = alternative.get("action")
        if not action:
            continue
        matched_move = codex_agent._match_external_move(game, codex_seat, possible_moves, action)
        if matched_move is None:
            continue
        key = action_key(action)
        if key in seen:
            continue
        seen.add(key)
        unique_actions.append(
            {
                "action": action,
                "actionId": alternative.get("actionId"),
                "utilityScore": float(alternative.get("utilityScore", 0.0)),
                "confidence": float(alternative.get("confidence", 0.0)),
                "rationale": alternative.get("rationale", []),
            }
        )
        if len(unique_actions) >= top_k:
            break
    return unique_actions


def evaluate_forced_suffix(
    seed: int,
    lineup: List[str],
    replay: Dict,
    suffix_start_decision_index: int,
    forced_actions: List[Dict],
    policy_weights: Optional[Dict],
    heuristic_weight: float,
    learned_weight: float,
) -> Dict:
    game, agents, codex_seat, frontier_reached = run_to_codex_frontier(
        seed=seed,
        lineup=lineup,
        replay=replay,
        suffix_start_decision_index=suffix_start_decision_index,
        forced_actions=forced_actions,
        frontier_decision_index=suffix_start_decision_index + len(forced_actions),
        policy_weights=policy_weights,
        heuristic_weight=heuristic_weight,
        learned_weight=learned_weight,
    )
    if codex_seat is None:
        raise RuntimeError("Could not reconstruct suffix branch for evaluation.")
    final_summary = continue_until_game_over(game, agents) if frontier_reached else summarize_final_state(game)
    final_summary["forcedActionCount"] = len(forced_actions)
    final_summary["forcedActions"] = copy.deepcopy(forced_actions)
    return final_summary


def search_suffix(
    seed: int,
    lineup: List[str],
    replay: Dict,
    suffix_start_decision_index: int,
    branch_actions: List[Dict],
    remaining_depth: int,
    branch_top_k: int,
    max_leaf_evaluations: int,
    policy_weights: Optional[Dict],
    heuristic_weight: float,
    learned_weight: float,
    results: List[Dict],
) -> None:
    if len(results) >= max_leaf_evaluations:
        return

    frontier_index = suffix_start_decision_index + len(branch_actions)
    game, agents, codex_seat, frontier_reached = run_to_codex_frontier(
        seed=seed,
        lineup=lineup,
        replay=replay,
        suffix_start_decision_index=suffix_start_decision_index,
        forced_actions=branch_actions,
        frontier_decision_index=frontier_index,
        policy_weights=policy_weights,
        heuristic_weight=heuristic_weight,
        learned_weight=learned_weight,
    )

    if codex_seat is None:
        result = evaluate_forced_suffix(
            seed=seed,
            lineup=lineup,
            replay=replay,
            suffix_start_decision_index=suffix_start_decision_index,
            forced_actions=branch_actions,
            policy_weights=policy_weights,
            heuristic_weight=heuristic_weight,
            learned_weight=learned_weight,
        )
        results.append(result)
        return

    if not frontier_reached:
        result = summarize_final_state(game)
        result["forcedActionCount"] = len(branch_actions)
        result["forcedActions"] = copy.deepcopy(branch_actions)
        results.append(result)
        return

    if remaining_depth <= 0:
        result = continue_until_game_over(game, agents)
        result["forcedActionCount"] = len(branch_actions)
        result["forcedActions"] = copy.deepcopy(branch_actions)
        results.append(result)
        return

    codex_agent = agents[codex_seat]
    alternatives = get_legal_alternatives(game, codex_agent, codex_seat, branch_top_k)
    if not alternatives:
        result = continue_until_game_over(game, agents)
        result["forcedActionCount"] = len(branch_actions)
        result["forcedActions"] = copy.deepcopy(branch_actions)
        results.append(result)
        return

    for alternative in alternatives:
        if len(results) >= max_leaf_evaluations:
            break
        search_suffix(
            seed=seed,
            lineup=lineup,
            replay=replay,
            suffix_start_decision_index=suffix_start_decision_index,
            branch_actions=[*branch_actions, alternative["action"]],
            remaining_depth=remaining_depth - 1,
            branch_top_k=branch_top_k,
            max_leaf_evaluations=max_leaf_evaluations,
            policy_weights=policy_weights,
            heuristic_weight=heuristic_weight,
            learned_weight=learned_weight,
            results=results,
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Brute-force suffix search over the last Codex decisions of a recorded replay."
    )
    parser.add_argument("--replays-json", required=True)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--game-id", default=None)
    parser.add_argument("--policy-weights-json", default="config/policy-weights.v1.0.5.json")
    parser.add_argument("--suffix-decisions", type=int, default=4)
    parser.add_argument("--branch-top-k", type=int, default=4)
    parser.add_argument("--max-leaf-evaluations", type=int, default=64)
    parser.add_argument("--heuristic-weight", type=float, default=0.55)
    parser.add_argument("--learned-weight", type=float, default=0.45)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-jsonl", default=None)
    args = parser.parse_args()

    payload = load_json(args.replays_json)
    replay = find_replay(payload, seed=args.seed, game_id=args.game_id)
    seed = args.seed if args.seed is not None else extract_seed(replay["gameId"])
    lineup = list(replay["agentNames"])
    codex_actions = extract_codex_actions(replay)
    if not codex_actions:
        raise RuntimeError("Replay contains no Codex actions.")

    baseline_result = summarize_replay_baseline(replay)

    start_index = max(0, len(codex_actions) - args.suffix_decisions)
    policy_weights = load_policy_weights(args.policy_weights_json)
    results: List[Dict] = []
    search_suffix(
        seed=seed,
        lineup=lineup,
        replay=replay,
        suffix_start_decision_index=start_index,
        branch_actions=[],
        remaining_depth=min(args.suffix_decisions, len(codex_actions)),
        branch_top_k=args.branch_top_k,
        max_leaf_evaluations=args.max_leaf_evaluations,
        policy_weights=policy_weights,
        heuristic_weight=args.heuristic_weight,
        learned_weight=args.learned_weight,
        results=results,
    )

    def sort_key(row: Dict) -> Tuple[int, int, int]:
        return (-int(row["score"]), int(row["place"]), int(row["forcedActionCount"]))

    results.sort(key=sort_key)
    best = results[0] if results else None
    summary = {
        "replayGameId": replay["gameId"],
        "seed": seed,
        "lineup": lineup,
        "totalCodexDecisions": len(codex_actions),
        "suffixStartDecisionIndex": start_index,
        "suffixDecisionCount": min(args.suffix_decisions, len(codex_actions)),
        "branchTopK": args.branch_top_k,
        "maxLeafEvaluations": args.max_leaf_evaluations,
        "baseline": baseline_result,
        "evaluatedLeafCount": len(results),
        "best": best,
        "topLeaves": results[: min(12, len(results))],
    }
    write_json(args.output_json, summary)
    if args.output_jsonl:
        resolved_jsonl = resolve_path(args.output_jsonl)
        if os.path.exists(resolved_jsonl):
            os.remove(resolved_jsonl)
        for row in results:
            append_jsonl(args.output_jsonl, row)

    print(
        "suffix-search "
        f"game={replay['gameId']} seed={seed} "
        f"suffix_start={start_index} suffix_count={summary['suffixDecisionCount']} "
        f"evaluated={len(results)} "
        f"baseline_score={baseline_result['score']} baseline_place={baseline_result['place']} "
        f"best_score={best['score'] if best else 'n/a'} best_place={best['place'] if best else 'n/a'}"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
