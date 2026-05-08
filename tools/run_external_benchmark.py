import argparse
import copy
import json
import os
import random
import statistics
import sys
import time
from typing import Dict, List

import networkx as nx

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTERNAL_ROOT = os.path.join(ROOT_DIR, "third_party", "Ticket-to-Ride-Engine")
EXTERNAL_SCRIPTS = os.path.join(EXTERNAL_ROOT, "scripts")

sys.path.insert(0, EXTERNAL_SCRIPTS)

from loadDestinationDeck import destinationdeckdict, loaddestinationdeckfromfile
from loadMap import loadgraphfromfile
from ttrengine import Board, Game, Player, emptyCardDict, make_train_deck, point_table
from hungryAgent import HungryAgent
from longRouteJunkieAgent import LongRouteJunkieAgent
from oneStepThinkerAgent import OneStepThinkerAgent
from pathAgent import PathAgent

from external_engine_codex_agent import CodexSolverAgent, normalize_city, normalize_color, ticket_id_for_card


AGENT_FACTORIES = {
    "osa": lambda: OneStepThinkerAgent(),
    "lra": lambda: LongRouteJunkieAgent(),
    "path": lambda: PathAgent(),
    "hungry": lambda: HungryAgent(),
}


def patch_external_engine_face_up_refill() -> None:
    original_add_face_up_train_card = Game.addFaceUpTrainCard

    if getattr(original_add_face_up_train_card, "_codex_face_up_refill_patch", False):
        return

    def patched_add_face_up_train_card(self):
        if len(self.train_deck.deck) == 0 and sum(self.train_deck.discard_pile.values()) > 0:
            self.train_deck.reshuffle()
        return original_add_face_up_train_card(self)

    patched_add_face_up_train_card._codex_face_up_refill_patch = True
    Game.addFaceUpTrainCard = patched_add_face_up_train_card


patch_external_engine_face_up_refill()


def patch_external_engine_usa_board(board: Board) -> Board:
    graph = getattr(board, "graph", None)
    if graph is None:
        return board
    edge_map = graph.get_edge_data("SALT LAKE CITY", "SAN FRANCISCO", default={})
    for edge_key, edge_data in edge_map.items():
        if edge_data.get("color") in {"WHITE", "ORANGE"}:
            graph["SALT LAKE CITY"]["SAN FRANCISCO"][edge_key]["weight"] = 5
    return board


def find_primary_codex_seat(agent_names: List[str]) -> int | None:
    try:
        return agent_names.index("codex")
    except ValueError:
        return None


def describe_move(move, actor_name: str, offered_ticket_ids: List[str] | None = None) -> Dict:
    if move.function == "drawTrainCard":
        if str(move.args).lower() == "top":
            return {
                "kind": "draw-train-hidden",
                "summary": f"{actor_name} drew a hidden train card.",
            }
        color = normalize_color(str(move.args))
        return {
            "kind": "draw-train-face-up",
            "color": color,
            "summary": f"{actor_name} took {color} from the face-up pool.",
        }

    if move.function == "drawDestinationCards":
        return {
            "kind": "draw-destination-tickets",
            "summary": f"{actor_name} drew destination tickets.",
        }

    if move.function == "chooseDestinationCards":
        kept_count = len(move.args[1]) if isinstance(move.args, list) and len(move.args) > 1 else 0
        kept_ticket_ids = (
            [ticket_id_for_card(card) for card in move.args[1]]
            if isinstance(move.args, list) and len(move.args) > 1
            else []
        )
        return {
            "kind": "keep-destination-tickets",
            "keptCount": kept_count,
            "offeredTicketIds": offered_ticket_ids or [],
            "keptTicketIds": kept_ticket_ids,
            "summary": f"{actor_name} kept {kept_count} destination ticket(s).",
        }

    if move.function == "claimRoute":
        city_a = normalize_city(move.args[0])
        city_b = normalize_city(move.args[1])
        color = normalize_color(str(move.args[2]))
        return {
            "kind": "claim-route",
            "cityA": city_a,
            "cityB": city_b,
            "color": color,
            "summary": f"{actor_name} claimed {city_a} - {city_b} using {color}.",
        }

    return {
        "kind": move.function,
        "summary": f"{actor_name} made move {move.function}.",
    }


def extract_codex_decision(agent) -> Dict | None:
    trace_steps = getattr(agent, "trace_steps", [])
    if not trace_steps:
        return None

    latest = trace_steps[-1]
    chosen = None
    for alternative in latest.get("alternatives", []):
        if alternative.get("actionId") == latest.get("chosenActionId"):
            chosen = alternative
            break

    top_rationale = chosen.get("rationale", []) if chosen else latest.get("alternatives", [{}])[0].get("rationale", [])

    return {
        "turnIndex": latest.get("turnIndex"),
        "phase": latest.get("phase"),
        "chosenActionId": latest.get("chosenActionId"),
        "chosenAction": latest.get("chosenAction"),
        "topRationale": top_rationale,
        "alternatives": latest.get("alternatives", [])[:5],
        "knownHand": latest.get("knownHand", {}),
        "knownTicketIds": latest.get("knownTicketIds", []),
    }


def play_game_with_trace(
    game,
    agents: List[object],
    agent_names: List[str],
    game_id: str,
    collect_replay: bool = False,
) -> Dict | None:
    primary_codex_seat = find_primary_codex_seat(agent_names)
    primary_codex_agent = (
        agents[primary_codex_seat]
        if primary_codex_seat is not None and isinstance(agents[primary_codex_seat], CodexSolverAgent)
        else None
    )

    replay = None
    if collect_replay:
        replay = {
            "gameId": game_id,
            "agentNames": agent_names,
            "codexSeat": primary_codex_seat,
            "initialSnapshot": primary_codex_agent.build_replay_snapshot(copy.deepcopy(game), primary_codex_seat)
            if primary_codex_agent is not None and primary_codex_seat is not None
            else None,
            "steps": [],
        }

    codex_agents = [
        (seat_index, agent)
        for seat_index, agent in enumerate(agents)
        if isinstance(agent, CodexSolverAgent)
    ]

    for seat in range(0, game.number_of_players):
        offered_ticket_ids = None
        if game.players_choosing_destination_cards or game.players[seat].choosing_destination_cards:
            offered_ticket_ids = [ticket_id_for_card(card) for card in game.list_pending_destination_cards(seat)]
        move = agents[seat].decide(game.copy(), seat)
        game.make_move(move.function, move.args)
        for codex_seat, codex_agent in codex_agents:
            codex_agent.observe_move(move, seat, codex_seat)

        if replay is not None:
            step = {
                "index": len(replay["steps"]),
                "actorSeat": seat,
                "actorName": agent_names[seat],
                "move": describe_move(move, agent_names[seat], offered_ticket_ids),
            }

            if primary_codex_agent is not None and primary_codex_seat is not None:
                step["snapshot"] = primary_codex_agent.build_replay_snapshot(copy.deepcopy(game), primary_codex_seat)
                if seat == primary_codex_seat:
                    codex_decision = extract_codex_decision(primary_codex_agent)
                    if codex_decision:
                        step["codexDecision"] = codex_decision

            replay["steps"].append(step)

    while game.game_over is False:
        current_seat = game.current_player
        offered_ticket_ids = None
        if game.players_choosing_destination_cards or game.players[current_seat].choosing_destination_cards:
            offered_ticket_ids = [
                ticket_id_for_card(card) for card in game.list_pending_destination_cards(current_seat)
            ]
        move = agents[current_seat].decide(game, current_seat)
        game.make_move(move.function, move.args)
        for codex_seat, codex_agent in codex_agents:
            codex_agent.observe_move(move, current_seat, codex_seat)

        if replay is not None:
            step = {
                "index": len(replay["steps"]),
                "actorSeat": current_seat,
                "actorName": agent_names[current_seat],
                "move": describe_move(move, agent_names[current_seat], offered_ticket_ids),
            }

            if primary_codex_agent is not None and primary_codex_seat is not None:
                step["snapshot"] = primary_codex_agent.build_replay_snapshot(copy.deepcopy(game), primary_codex_seat)
                if current_seat == primary_codex_seat:
                    codex_decision = extract_codex_decision(primary_codex_agent)
                    if codex_decision:
                        step["codexDecision"] = codex_decision

            replay["steps"].append(step)

    if replay is not None:
        replay["finalScores"] = [
            {
                "seat": index,
                "agentName": agent_names[index],
                "score": game.players[index].points,
            }
            for index in range(game.number_of_players)
        ]

    return replay


def make_game(player_count: int):
    board = patch_external_engine_usa_board(
        Board(loadgraphfromfile(os.path.join(EXTERNAL_ROOT, "gameContent", "usa.txt")))
    )
    destination_deck = destinationdeckdict(
        dest_list=loaddestinationdeckfromfile(os.path.join(EXTERNAL_ROOT, "gameContent", "usa_destinations.txt")),
        board="usa",
    )
    players = [Player(hand=emptyCardDict(), number_of_trains=45, points=0) for _ in range(player_count)]
    game = Game(
        board=board,
        point_table=point_table(),
        destination_deck=destination_deck,
        train_deck=make_train_deck(number_of_color_cards=12, number_of_wildcards=14),
        players=players,
        current_player=0,
        variants=[3, 2, 3, 1, True, False, False, False, False, False, 4, 5, 2, 3, 2, 10, 15, 2, False],
    )
    game.setup()
    return game


def instantiate_agents(specs, policy_model_path=None, heuristic_weight=0.55, learned_weight=0.45):
    agents = []
    for name in specs:
        if name == "codex":
            agents.append(
                CodexSolverAgent(
                    policy_model_path=policy_model_path,
                    heuristic_weight=heuristic_weight,
                    learned_weight=learned_weight,
                )
            )
        else:
            agents.append(AGENT_FACTORIES[name]())
    return agents


def is_ticket_completed(player_graph, destination_card) -> bool:
    try:
        return nx.has_path(player_graph, destination_card.destinations[0], destination_card.destinations[1])
    except Exception:
        return False


def count_completed_tickets(game, player_index: int) -> int:
    player_graph = game.player_graph(player_index)
    return sum(1 for card in game.players[player_index].hand_destination_cards if is_ticket_completed(player_graph, card))


def get_completed_ticket_ids(game, player_index: int) -> List[str]:
    player_graph = game.player_graph(player_index)
    completed = []
    for card in game.players[player_index].hand_destination_cards:
        if is_ticket_completed(player_graph, card):
            completed.append(ticket_id_for_card(card))
    return completed


def get_failed_ticket_ids(game, player_index: int) -> List[str]:
    player_graph = game.player_graph(player_index)
    failed = []
    for card in game.players[player_index].hand_destination_cards:
        if not is_ticket_completed(player_graph, card):
            failed.append(ticket_id_for_card(card))
    return failed


def longest_route_lengths(game) -> List[int]:
    lengths = []
    for player_index in range(game.number_of_players):
        graph = game.player_graph(player_index)
        if len(graph.edges()) == 0:
            lengths.append(0)
            continue

        best = 0
        for node in graph.nodes():
            try:
                candidate = game.findMaxWeightSumForNode(graph, node, [])
            except Exception:
                candidate = 0
            if candidate > best:
                best = candidate
        lengths.append(best)
    return lengths


def get_longest_route_winners(game) -> List[int]:
    lengths = longest_route_lengths(game)
    if not lengths:
        return []
    best = max(lengths)
    return [index for index, length in enumerate(lengths) if length == best]


def materialize_training_rows(
    game_id: str,
    game,
    agent_names: List[str],
    agents: List[object],
    placements: Dict[int, int],
) -> List[Dict]:
    longest_route_winners = set(get_longest_route_winners(game))
    rows: List[Dict] = []

    for player_index, agent_name in enumerate(agent_names):
        if agent_name != "codex":
            continue

        agent = agents[player_index]
        completed_ticket_ids = get_completed_ticket_ids(game, player_index)
        failed_ticket_ids = get_failed_ticket_ids(game, player_index)
        outcome = {
            "finalScore": game.players[player_index].points,
            "finalPlace": placements[player_index],
            "wonGame": placements[player_index] == 1,
            "longestRouteWon": player_index in longest_route_winners,
            "completedTicketCount": len(completed_ticket_ids),
            "completedTicketIds": completed_ticket_ids,
            "failedTicketIds": failed_ticket_ids,
        }

        for step in getattr(agent, "trace_steps", []):
            alternatives = step.get("alternatives", [])
            for alternative in alternatives:
                rows.append(
                    {
                        "gameId": game_id,
                        "turnIndex": step["turnIndex"],
                        "playerId": step["playerId"],
                        "playerCount": step["playerCount"],
                        "variant": step["variant"],
                        "phase": step["phase"],
                        "seatIndex": step["seatIndex"],
                        "candidateActionId": alternative["actionId"],
                        "candidateAction": alternative["action"],
                        "heuristicUtilityScore": alternative["utilityScore"],
                        "heuristicConfidence": alternative["confidence"],
                        "heuristicTopRationale": alternative["rationale"],
                        "featureBreakdown": alternative["featureBreakdown"],
                        "wasChosen": alternative["actionId"] == step.get("chosenActionId"),
                        "knownHand": step["knownHand"],
                        "knownTicketIds": step["knownTicketIds"],
                        **outcome,
                    }
                )

    return rows


def append_jsonl_rows(path: str, rows: List[Dict]) -> None:
    if not rows:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def append_jsonl_row(path: str, row: Dict) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def write_json(path: str, payload: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def initialize_output_file(path: str, append_mode: bool) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not append_mode:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("")


def compute_percentile(values: List[float], percentile: float) -> float:
    if not values:
        return 0
    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    rank = (len(sorted_values) - 1) * percentile
    lower_index = int(rank)
    upper_index = min(lower_index + 1, len(sorted_values) - 1)
    lower_value = sorted_values[lower_index]
    upper_value = sorted_values[upper_index]
    fraction = rank - lower_index
    return lower_value + (upper_value - lower_value) * fraction


def summarize_codex_rows(rows: List[Dict]) -> Dict:
    scores = [row["score"] for row in rows]
    places = [row["place"] for row in rows]
    placement_counts = {str(place): sum(1 for row in rows if row["place"] == place) for place in range(1, 5)}
    max_row = max(rows, key=lambda row: row["score"]) if rows else None
    min_row = min(rows, key=lambda row: row["score"]) if rows else None

    return {
        "gameCount": len(rows),
        "winRate": sum(1 for row in rows if row["place"] == 1) / len(rows) if rows else 0,
        "averageScore": statistics.mean(scores) if scores else 0,
        "averagePlace": statistics.mean(places) if places else 0,
        "placementCounts": placement_counts,
        "maxScore": max_row["score"] if max_row else None,
        "maxScoreGame": max_row["game"] if max_row else None,
        "maxScoreSeat": max_row["seat"] if max_row else None,
        "minScore": min_row["score"] if min_row else None,
        "minScoreGame": min_row["game"] if min_row else None,
        "minScoreSeat": min_row["seat"] if min_row else None,
        "scoreP10": compute_percentile(scores, 0.10),
        "scoreP90": compute_percentile(scores, 0.90),
    }


def summarize_turn_counts(turn_counts: List[int]) -> Dict:
    return {
        "averageTurnCount": statistics.mean(turn_counts) if turn_counts else 0,
        "maxTurnCount": max(turn_counts) if turn_counts else None,
        "minTurnCount": min(turn_counts) if turn_counts else None,
    }


def run_matchup(
    agent_names,
    games,
    seed_base,
    policy_model_path=None,
    heuristic_weight=0.55,
    learned_weight=0.45,
    training_output_path=None,
    failed_games_output_path=None,
    progress_callback=None,
    lineup_index=0,
    collect_replays=False,
):
    codex_scores = []
    codex_places = []
    codex_wins = 0
    rows = []
    game_results = []
    replays = []
    training_row_count = 0
    failed_games = []
    turn_counts = []
    started_at = time.time()

    for game_index in range(games):
        game_started_at = time.time()
        random.seed(seed_base + game_index)
        game = make_game(len(agent_names))
        agents = instantiate_agents(
            agent_names,
            policy_model_path=policy_model_path,
            heuristic_weight=heuristic_weight,
            learned_weight=learned_weight,
        )
        try:
            replay = play_game_with_trace(
                game,
                agents,
                agent_names,
                f"{'-'.join(agent_names)}-g{game_index}",
                collect_replay=collect_replays,
            )
        except Exception as error:
            failed_payload = {
                "lineupIndex": lineup_index,
                "agentNames": agent_names,
                "game": game_index,
                "seed": seed_base + game_index,
                "error": str(error),
                "elapsedSeconds": round(time.time() - game_started_at, 2),
                "policyModel": policy_model_path,
            }
            failed_games.append(failed_payload)
            if failed_games_output_path:
                append_jsonl_row(failed_games_output_path, failed_payload)
            if progress_callback:
                progress_callback(
                    {
                        "lineupIndex": lineup_index,
                        "agentNames": agent_names,
                        "gameIndex": game_index,
                        "attemptedGames": game_index + 1,
                        "completedGames": len(rows),
                        "failedGames": len(failed_games),
                        "trainingRowCount": training_row_count,
                        "lastStatus": "failed",
                        "lastElapsedSeconds": round(time.time() - game_started_at, 2),
                        "lastError": str(error),
                    }
                )
            continue

        ordered = sorted(
            [(index, player.points) for index, player in enumerate(game.players)],
            key=lambda item: item[1],
            reverse=True,
        )
        placements = {}
        for place, (player_index, _) in enumerate(ordered, start=1):
            placements[player_index] = place

        for player_index, agent_name in enumerate(agent_names):
            if agent_name != "codex":
                continue

            score = game.players[player_index].points
            place = placements[player_index]
            codex_scores.append(score)
            codex_places.append(place)
            if place == 1:
                codex_wins += 1
            rows.append(
                {
                    "game": game_index,
                    "seat": player_index,
                    "score": score,
                    "place": place,
                }
            )

        game_id = f"{'-'.join(agent_names)}-g{game_index}"
        if replay is not None:
            replay["placements"] = placements
            replays.append(replay)
        turn_count = len(replay["steps"]) if replay is not None else None
        if turn_count is not None:
            turn_counts.append(turn_count)
        final_scores = [
            {
                "seat": index,
                "agentName": agent_names[index],
                "score": int(game.players[index].points),
                "place": placements[index],
            }
            for index in range(game.number_of_players)
        ]
        game_results.append(
            {
                "game": game_index,
                "seed": seed_base + game_index,
                "turnCount": turn_count,
                "finalScores": final_scores,
            }
        )
        new_training_rows = materialize_training_rows(game_id, game, agent_names, agents, placements)
        training_row_count += len(new_training_rows)
        if training_output_path:
            append_jsonl_rows(training_output_path, new_training_rows)

        if progress_callback:
            progress_callback(
                {
                    "lineupIndex": lineup_index,
                    "agentNames": agent_names,
                    "gameIndex": game_index,
                    "attemptedGames": game_index + 1,
                    "completedGames": len(rows),
                    "failedGames": len(failed_games),
                    "trainingRowCount": training_row_count,
                    "lastStatus": "completed",
                    "lastElapsedSeconds": round(time.time() - game_started_at, 2),
                    "lastCodexScore": score,
                    "lastCodexPlace": place,
                }
            )

    codex_summary = summarize_codex_rows(rows)
    turn_summary = summarize_turn_counts(turn_counts)

    return {
        "agent_names": agent_names,
        "games": games,
        "codexWinRate": codex_summary["winRate"],
        "codexAverageScore": codex_summary["averageScore"],
        "codexAveragePlace": codex_summary["averagePlace"],
        "codexPlacementCounts": codex_summary["placementCounts"],
        "codexMaxScore": codex_summary["maxScore"],
        "codexMaxScoreGame": codex_summary["maxScoreGame"],
        "codexMinScore": codex_summary["minScore"],
        "codexMinScoreGame": codex_summary["minScoreGame"],
        "codexScoreP10": codex_summary["scoreP10"],
        "codexScoreP90": codex_summary["scoreP90"],
        "averageTurnCount": turn_summary["averageTurnCount"],
        "maxTurnCount": turn_summary["maxTurnCount"],
        "minTurnCount": turn_summary["minTurnCount"],
        "rows": rows,
        "gameResults": game_results,
        "replays": replays,
        "trainingRowCount": training_row_count,
        "failedGames": failed_games,
        "elapsedSeconds": round(time.time() - started_at, 2),
    }


def build_rotated_matchups(base_lineup, rotations):
    lineups = []
    seen = set()
    for rotation in range(rotations):
        lineup = base_lineup[:]
        codex_index = rotation % len(lineup)
        lineup[codex_index], lineup[0] = lineup[0], lineup[codex_index]
        lineup_key = tuple(lineup)
        if lineup_key in seen:
            continue
        seen.add(lineup_key)
        lineups.append(lineup)
    return lineups


def main():
    parser = argparse.ArgumentParser(description="Run external Ticket to Ride benchmarks for the Codex solver.")
    parser.add_argument("--games", type=int, default=8, help="Games per rotated seat lineup.")
    parser.add_argument(
        "--rotations",
        type=int,
        default=None,
        help="How many seat rotations to run. Defaults to the lineup length.",
    )
    parser.add_argument(
        "--lineup",
        nargs="+",
        default=["codex", "osa", "lra", "path"],
        help="Lineup of agents. Use codex, osa, lra, hungry, path.",
    )
    parser.add_argument("--seed-base", type=int, default=1000)
    parser.add_argument("--policy-model", default=None, help="Optional learned reranker model JSON path.")
    parser.add_argument("--heuristic-weight", type=float, default=0.55)
    parser.add_argument("--learned-weight", type=float, default=0.45)
    parser.add_argument(
        "--export-training-jsonl",
        default="artifacts/benchmark-training-corpus.jsonl",
        help="Where to write benchmark-derived training rows.",
    )
    parser.add_argument(
        "--export-summary-json",
        default="artifacts/benchmark-training-summary.json",
        help="Where to write a compact benchmark/training summary.",
    )
    parser.add_argument(
        "--export-failed-jsonl",
        default="artifacts/benchmark-failed-games.jsonl",
        help="Where to append failed game records.",
    )
    parser.add_argument(
        "--export-progress-json",
        default="artifacts/benchmark-progress.json",
        help="Where to keep the latest progress checkpoint.",
    )
    parser.add_argument(
        "--export-replays-json",
        default=None,
        help="Optional JSON file containing replay snapshots for generated games.",
    )
    parser.add_argument(
        "--append-output",
        action="store_true",
        help="Append to JSONL outputs instead of truncating them first.",
    )
    args = parser.parse_args()

    if "codex" not in args.lineup:
        raise SystemExit("Lineup must include 'codex'.")

    training_output_path = os.path.join(ROOT_DIR, args.export_training_jsonl)
    summary_output_path = os.path.join(ROOT_DIR, args.export_summary_json)
    failed_games_output_path = os.path.join(ROOT_DIR, args.export_failed_jsonl)
    progress_output_path = os.path.join(ROOT_DIR, args.export_progress_json)
    replay_output_path = (
        os.path.join(ROOT_DIR, args.export_replays_json)
        if args.export_replays_json
        else None
    )

    initialize_output_file(training_output_path, args.append_output)
    initialize_output_file(failed_games_output_path, args.append_output)

    started_at = time.time()
    progress_state = {
        "startedAtEpoch": started_at,
        "startedAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at)),
        "lineup": args.lineup,
        "gamesPerSeatRotation": args.games,
        "policyModel": args.policy_model,
        "heuristicWeight": args.heuristic_weight,
        "learnedWeight": args.learned_weight,
        "status": "running",
        "currentLineupIndex": 0,
        "attemptedGames": 0,
        "completedGames": 0,
        "failedGames": 0,
        "trainingRowCount": 0,
        "lastStatus": "starting",
    }
    write_json(progress_output_path, progress_state)

    summaries = []
    rotation_count = args.rotations if args.rotations is not None else len(args.lineup)
    rotated_lineups = build_rotated_matchups(args.lineup, rotation_count)
    for lineup_index, lineup in enumerate(rotated_lineups):
        def update_progress(lineup_progress: Dict) -> None:
            progress_state.update(
                {
                    "currentLineupIndex": lineup_index,
                    "currentAgentNames": lineup,
                    "attemptedGames":
                        sum(len(summary["rows"]) + len(summary["failedGames"]) for summary in summaries)
                        + lineup_progress["attemptedGames"],
                    "completedGames":
                        sum(len(summary["rows"]) for summary in summaries) + lineup_progress["completedGames"],
                    "failedGames":
                        sum(len(summary["failedGames"]) for summary in summaries) + lineup_progress["failedGames"],
                    "trainingRowCount":
                        sum(summary["trainingRowCount"] for summary in summaries)
                        + lineup_progress["trainingRowCount"],
                    "lastStatus": lineup_progress["lastStatus"],
                    "lastGameIndex": lineup_progress["gameIndex"],
                    "lastElapsedSeconds": lineup_progress["lastElapsedSeconds"],
                }
            )
            if "lastError" in lineup_progress:
                progress_state["lastError"] = lineup_progress["lastError"]
            else:
                progress_state.pop("lastError", None)
            if "lastCodexScore" in lineup_progress:
                progress_state["lastCodexScore"] = lineup_progress["lastCodexScore"]
                progress_state["lastCodexPlace"] = lineup_progress["lastCodexPlace"]
            write_json(progress_output_path, progress_state)

        summary = run_matchup(
            lineup,
            args.games,
            args.seed_base + len(summaries) * 100,
            policy_model_path=args.policy_model,
            heuristic_weight=args.heuristic_weight,
            learned_weight=args.learned_weight,
            training_output_path=training_output_path,
            failed_games_output_path=failed_games_output_path,
            progress_callback=update_progress,
            lineup_index=lineup_index,
            collect_replays=bool(replay_output_path),
        )
        summaries.append(summary)
        print(
            f"lineup={','.join(lineup)} games={summary['games']} "
            f"codex_win_rate={summary['codexWinRate']:.3f} "
            f"codex_avg_score={summary['codexAverageScore']:.2f} "
            f"codex_avg_place={summary['codexAveragePlace']:.2f} "
            f"failed={len(summary['failedGames'])} "
            f"rows={summary['trainingRowCount']} "
            f"elapsed={summary['elapsedSeconds']:.2f}s"
        )

    all_rows = [row for summary in summaries for row in summary["rows"]]
    all_turn_counts = [
        game_result["turnCount"]
        for summary in summaries
        for game_result in summary["gameResults"]
        if game_result.get("turnCount") is not None
    ]
    aggregate_codex_summary = summarize_codex_rows(all_rows)
    aggregate_turn_summary = summarize_turn_counts(all_turn_counts)
    if all_rows:
        print(
            "\naggregate "
            f"games={aggregate_codex_summary['gameCount']} "
            f"codex_win_rate={aggregate_codex_summary['winRate']:.3f} "
            f"codex_avg_score={aggregate_codex_summary['averageScore']:.2f} "
            f"codex_avg_place={aggregate_codex_summary['averagePlace']:.2f} "
            f"avg_turns={aggregate_turn_summary['averageTurnCount']:.1f} "
            f"places=({aggregate_codex_summary['placementCounts']['1']},"
            f"{aggregate_codex_summary['placementCounts']['2']},"
            f"{aggregate_codex_summary['placementCounts']['3']},"
            f"{aggregate_codex_summary['placementCounts']['4']}) "
            f"max={aggregate_codex_summary['maxScore']}@g{aggregate_codex_summary['maxScoreGame']} "
            f"min={aggregate_codex_summary['minScore']}@g{aggregate_codex_summary['minScoreGame']} "
            f"p10={aggregate_codex_summary['scoreP10']:.2f} "
            f"p90={aggregate_codex_summary['scoreP90']:.2f}"
        )

    summary_payload = {
        "lineup": args.lineup,
        "gamesPerSeatRotation": args.games,
        "rotations": len(summaries),
        "aggregateGameCount": aggregate_codex_summary["gameCount"],
        "aggregateTrainingRowCount": sum(summary["trainingRowCount"] for summary in summaries),
        "policyModel": args.policy_model,
        "heuristicWeight": args.heuristic_weight,
        "learnedWeight": args.learned_weight,
        "failedGamesOutputPath": failed_games_output_path,
        "trainingOutputPath": training_output_path,
        "progressOutputPath": progress_output_path,
        "replayOutputPath": replay_output_path,
        "elapsedSeconds": round(time.time() - started_at, 2),
        "aggregateCodexWinRate": aggregate_codex_summary["winRate"],
        "aggregateCodexAverageScore": aggregate_codex_summary["averageScore"],
        "aggregateCodexAveragePlace": aggregate_codex_summary["averagePlace"],
        "aggregatePlacementCounts": aggregate_codex_summary["placementCounts"],
        "aggregateMaxScore": aggregate_codex_summary["maxScore"],
        "aggregateMaxScoreGame": aggregate_codex_summary["maxScoreGame"],
        "aggregateMaxScoreSeat": aggregate_codex_summary["maxScoreSeat"],
        "aggregateMinScore": aggregate_codex_summary["minScore"],
        "aggregateMinScoreGame": aggregate_codex_summary["minScoreGame"],
        "aggregateMinScoreSeat": aggregate_codex_summary["minScoreSeat"],
        "aggregateScoreP10": aggregate_codex_summary["scoreP10"],
        "aggregateScoreP90": aggregate_codex_summary["scoreP90"],
        "aggregateAverageTurnCount": aggregate_turn_summary["averageTurnCount"],
        "aggregateMaxTurnCount": aggregate_turn_summary["maxTurnCount"],
        "aggregateMinTurnCount": aggregate_turn_summary["minTurnCount"],
        "summaries": [
            {
                "agentNames": summary["agent_names"],
                "games": summary["games"],
                "codexWinRate": summary["codexWinRate"],
                "codexAverageScore": summary["codexAverageScore"],
                "codexAveragePlace": summary["codexAveragePlace"],
                "codexPlacementCounts": summary["codexPlacementCounts"],
                "codexMaxScore": summary["codexMaxScore"],
                "codexMaxScoreGame": summary["codexMaxScoreGame"],
                "codexMinScore": summary["codexMinScore"],
                "codexMinScoreGame": summary["codexMinScoreGame"],
                "codexScoreP10": summary["codexScoreP10"],
                "codexScoreP90": summary["codexScoreP90"],
                "averageTurnCount": summary["averageTurnCount"],
                "maxTurnCount": summary["maxTurnCount"],
                "minTurnCount": summary["minTurnCount"],
                "trainingRowCount": summary["trainingRowCount"],
                "failedGameCount": len(summary["failedGames"]),
                "elapsedSeconds": summary["elapsedSeconds"],
                "gameResults": summary["gameResults"],
            }
            for summary in summaries
        ],
    }
    write_json(summary_output_path, summary_payload)

    if replay_output_path:
        replay_payload = {
            "schemaVersion": 1,
            "lineup": args.lineup,
            "gamesPerSeatRotation": args.games,
            "policyModel": args.policy_model,
            "heuristicWeight": args.heuristic_weight,
            "learnedWeight": args.learned_weight,
            "games": [
                replay
                for summary in summaries
                for replay in summary.get("replays", [])
            ],
        }
        write_json(replay_output_path, replay_payload)

    progress_state.update(
        {
            "status": "completed",
            "completedAtEpoch": time.time(),
            "completedAtIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "attemptedGames": sum(len(summary["rows"]) + len(summary["failedGames"]) for summary in summaries),
            "completedGames": len(all_rows),
            "failedGames": sum(len(summary["failedGames"]) for summary in summaries),
            "trainingRowCount": sum(summary["trainingRowCount"] for summary in summaries),
        }
    )
    write_json(progress_output_path, progress_state)

    print(f"\ntraining_rows_written={sum(summary['trainingRowCount'] for summary in summaries)}")
    print(f"training_jsonl={training_output_path}")
    print(f"failed_games_jsonl={failed_games_output_path}")
    print(f"progress_json={progress_output_path}")
    print(f"training_summary={summary_output_path}")
    if replay_output_path:
        print(f"replays_json={replay_output_path}")


if __name__ == "__main__":
    main()
