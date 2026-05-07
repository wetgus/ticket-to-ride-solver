import json
import os
import subprocess
import atexit
from typing import Dict, List, Optional, Tuple


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_CLI_PATH = os.path.join(ROOT_DIR, "tools", "solver_action_cli.mjs")
NODE_WORKER_PATH = os.path.join(ROOT_DIR, "tools", "solver_action_worker.mjs")


COLOR_MAP = {
    "red": "red",
    "orange": "orange",
    "blue": "blue",
    "pink": "pink",
    "white": "white",
    "yellow": "yellow",
    "black": "black",
    "green": "green",
    "wild": "locomotive",
}


CITY_MAP = {
    "ATLANTA": "atlanta",
    "BOSTON": "boston",
    "CALGARY": "calgary",
    "CHARLESTON": "charleston",
    "CHICAGO": "chicago",
    "DALLAS": "dallas",
    "DENVER": "denver",
    "DULUTH": "duluth",
    "EL PASO": "el-paso",
    "HELENA": "helena",
    "HOUSTON": "houston",
    "KANSAS CITY": "kansas-city",
    "LAS VEGAS": "las-vegas",
    "LITTLE ROCK": "little-rock",
    "LOS ANGELES": "los-angeles",
    "MIAMI": "miami",
    "MONTREAL": "montreal",
    "NASHVILLE": "nashville",
    "NEW ORLEANS": "new-orleans",
    "NEW YORK": "new-york",
    "OMAHA": "omaha",
    "OKLAHOMA CITY": "oklahoma-city",
    "PHOENIX": "phoenix",
    "PITTSBURGH": "pittsburgh",
    "PORTLAND": "portland",
    "RALEIGH": "raleigh",
    "SAINT LOUIS": "saint-louis",
    "ST. LOUIS": "saint-louis",
    "SALT LAKE CITY": "salt-lake-city",
    "SAN FRANCISCO": "san-francisco",
    "SANTA FE": "santa-fe",
    "SAULT ST. MARIE": "sault-st-marie",
    "SEATTLE": "seattle",
    "TORONTO": "toronto",
    "VANCOUVER": "vancouver",
    "WASHINGTON": "washington",
    "WINNIPEG": "winnipeg",
}


def canonical_ticket_key(city_a: str, city_b: str, points: int) -> Tuple[str, str, int]:
    ordered = tuple(sorted((city_a.upper(), city_b.upper())))
    return ordered[0], ordered[1], int(points)


TICKET_MAP = {
    canonical_ticket_key("DENVER", "EL PASO", 4): "denver-el-paso",
    canonical_ticket_key("KANSAS CITY", "HOUSTON", 5): "kansas-city-houston",
    canonical_ticket_key("NEW YORK", "ATLANTA", 6): "new-york-atlanta",
    canonical_ticket_key("CALGARY", "PHOENIX", 13): "calgary-phoenix",
    canonical_ticket_key("VANCOUVER", "SANTA FE", 13): "vancouver-santa-fe",
    canonical_ticket_key("LOS ANGELES", "NEW YORK", 21): "los-angeles-new-york",
    canonical_ticket_key("MONTREAL", "ATLANTA", 9): "montreal-atlanta",
    canonical_ticket_key("SEATTLE", "LOS ANGELES", 9): "seattle-los-angeles",
    canonical_ticket_key("DULUTH", "HOUSTON", 8): "duluth-houston",
    canonical_ticket_key("SAULT ST. MARIE", "NASHVILLE", 8): "sault-st-marie-nashville",
    canonical_ticket_key("NEW YORK", "MIAMI", 10): "new-york-miami",
    canonical_ticket_key("PORTLAND", "PHOENIX", 11): "portland-phoenix",
    canonical_ticket_key("SAN FRANCISCO", "ATLANTA", 17): "san-francisco-atlanta",
    canonical_ticket_key("WINNIPEG", "LITTLE ROCK", 11): "winnipeg-little-rock",
    canonical_ticket_key("LOS ANGELES", "MIAMI", 20): "los-angeles-miami",
    canonical_ticket_key("CHICAGO", "SANTA FE", 9): "chicago-santa-fe",
    canonical_ticket_key("TORONTO", "MIAMI", 10): "toronto-miami",
    canonical_ticket_key("DALLAS", "NEW YORK", 11): "dallas-new-york",
    canonical_ticket_key("CALGARY", "SALT LAKE CITY", 7): "calgary-salt-lake-city",
    canonical_ticket_key("DENVER", "PITTSBURGH", 11): "denver-pittsburgh",
    canonical_ticket_key("HELENA", "LOS ANGELES", 8): "helena-los-angeles",
    canonical_ticket_key("WINNIPEG", "HOUSTON", 12): "winnipeg-houston",
    canonical_ticket_key("MONTREAL", "NEW ORLEANS", 13): "montreal-new-orleans",
    canonical_ticket_key("SAULT ST. MARIE", "OKLAHOMA CITY", 9): "sault-st-marie-oklahoma-city",
    canonical_ticket_key("SEATTLE", "NEW YORK", 22): "seattle-new-york",
    canonical_ticket_key("BOSTON", "MIAMI", 12): "boston-miami",
    canonical_ticket_key("CHICAGO", "NEW ORLEANS", 7): "chicago-new-orleans",
    canonical_ticket_key("VANCOUVER", "MONTREAL", 20): "vancouver-montreal",
    canonical_ticket_key("DULUTH", "EL PASO", 10): "duluth-el-paso",
    canonical_ticket_key("LOS ANGELES", "CHICAGO", 16): "los-angeles-chicago",
    canonical_ticket_key("PORTLAND", "NASHVILLE", 17): "portland-nashville",
}


def normalize_city(city_name: str) -> str:
    key = city_name.strip().upper().replace("STE.", "ST.").replace("SAULT STE. MARIE", "SAULT ST. MARIE")
    if key not in CITY_MAP:
        raise KeyError(f"Unsupported city name: {city_name}")
    return CITY_MAP[key]


def normalize_color(color_name: str) -> str:
    key = color_name.strip().lower()
    if key not in COLOR_MAP:
        raise KeyError(f"Unsupported color name: {color_name}")
    return COLOR_MAP[key]


def route_signature(city_a: str, city_b: str, color: str, length: int) -> Tuple[str, str, str, int]:
    ordered = tuple(sorted((normalize_city(city_a), normalize_city(city_b))))
    return ordered[0], ordered[1], color, length


def destination_card_key(card) -> Tuple[str, str, int]:
    return canonical_ticket_key(card.destinations[0], card.destinations[1], card.points)


def ticket_id_for_card(card) -> str:
    key = destination_card_key(card)
    ticket_id = TICKET_MAP.get(key)
    if not ticket_id:
        raise KeyError(f"Unsupported destination card: {key}")
    return ticket_id


def empty_belief(player_id: str) -> Dict:
    return {
        "playerId": player_id,
        "handColorLowerBounds": {},
        "handColorExpectedCounts": {},
        "ticketFamilyPosterior": [],
        "archetypePosterior": [],
        "corridorInterest": [],
    }


class PersistentNodeSolverWorker:
    _instances: Dict[str, "PersistentNodeSolverWorker"] = {}

    def __init__(self, node_executable: str):
        self.node_executable = node_executable
        self.process = subprocess.Popen(
            [self.node_executable, NODE_WORKER_PATH],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=ROOT_DIR,
            bufsize=1,
        )

    @classmethod
    def for_executable(cls, node_executable: str) -> "PersistentNodeSolverWorker":
        worker = cls._instances.get(node_executable)
        if worker is None or worker.process.poll() is not None:
            worker = cls(node_executable)
            cls._instances[node_executable] = worker
        return worker

    @classmethod
    def shutdown_all(cls) -> None:
        for worker in list(cls._instances.values()):
            worker.close()
        cls._instances.clear()

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                if self.process.stdin:
                    self.process.stdin.close()
            except Exception:
                pass
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except Exception:
                self.process.kill()
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()

    def request(self, request_type: str, payload: Optional[Dict] = None):
        if self.process.poll() is not None:
            raise RuntimeError("Persistent solver worker exited unexpectedly.")

        if not self.process.stdin or not self.process.stdout:
            raise RuntimeError("Persistent solver worker streams are unavailable.")

        request_payload = {"type": request_type}
        if payload is not None:
            request_payload["payload"] = payload

        self.process.stdin.write(json.dumps(request_payload) + "\n")
        self.process.stdin.flush()

        response_line = self.process.stdout.readline()
        if not response_line:
            stderr_text = ""
            if self.process.stderr:
                try:
                    stderr_text = self.process.stderr.read()
                except Exception:
                    stderr_text = ""
            raise RuntimeError(
                "Persistent solver worker returned no response.\n"
                f"STDERR:\n{stderr_text}"
            )

        response = json.loads(response_line)
        if not response.get("ok"):
            raise RuntimeError(f"Persistent solver worker failed: {response.get('error', 'unknown error')}")

        return response.get("payload")


atexit.register(PersistentNodeSolverWorker.shutdown_all)


class CodexSolverAgent:
    def __init__(
        self,
        node_executable: str = "node",
        debug: bool = False,
        policy_model_path: Optional[str] = None,
        heuristic_weight: float = 0.55,
        learned_weight: float = 0.45,
    ):
        self.node_executable = node_executable
        self.debug = debug
        self.policy_model_path = policy_model_path
        self.heuristic_weight = heuristic_weight
        self.learned_weight = learned_weight
        self.trace_steps = []
        self.decision_counter = 0
        self._worker = PersistentNodeSolverWorker.for_executable(self.node_executable)
        self._observed_visible_lower_bounds = {}
        self._known_out_of_deck_counts = {}
        self._player_count = None

    def build_replay_snapshot(self, game, pnum: int) -> Dict:
        self._ensure_observation_state(game, pnum)
        return self._build_payload(game, pnum)["gameState"]

    def decide(self, game, pnum):
        self._ensure_observation_state(game, pnum)
        payload = self._build_payload(game, pnum)
        recommendation = self._request_solver_recommendation(payload)
        possible_moves = game.get_possible_moves(pnum)

        for alternative in recommendation.get("alternatives", []):
            matched = self._match_external_move(game, pnum, possible_moves, alternative.get("action"))
            if matched is not None:
                self._record_trace_step(payload, pnum, recommendation, alternative)
                return matched

        recovered_move = self._recover_when_no_possible_moves(game, pnum, possible_moves)
        if recovered_move is not None:
            self._record_trace_step(payload, pnum, recommendation, None)
            return recovered_move

        if self.debug:
            print("CodexSolverAgent fallback; top rationale:", recommendation.get("topRationale", []))

        if possible_moves:
            self._record_trace_step(payload, pnum, recommendation, None)
            return possible_moves[0]

        raise RuntimeError(self._build_empty_move_state_error(game, pnum, recommendation))

    def _record_trace_step(self, payload: Dict, pnum: int, recommendation: Dict, chosen_alternative: Optional[Dict]) -> None:
        game_state = payload["gameState"]
        self.trace_steps.append(
            {
                "turnIndex": self.decision_counter,
                "seatIndex": pnum,
                "playerId": game_state["ourState"]["playerId"],
                "playerCount": game_state["rules"]["playerCount"],
                "variant": game_state["rules"]["extension"],
                "phase": game_state["publicState"]["phase"],
                "knownHand": game_state["ourState"]["hand"],
                "knownTicketIds": game_state["ourState"]["ticketIds"],
                "chosenActionId": chosen_alternative["actionId"] if chosen_alternative else None,
                "chosenAction": chosen_alternative["action"] if chosen_alternative else None,
                "alternatives": recommendation.get("alternatives", []),
            }
        )
        self.decision_counter += 1

    def _request_solver_recommendation(self, payload: Dict) -> Dict:
        return self._worker.request("recommend", payload)

    def _ensure_observation_state(self, game, pnum: int) -> None:
        if self._player_count == game.number_of_players and self._observed_visible_lower_bounds:
            return

        our_player_id = f"p{pnum}"
        self._player_count = game.number_of_players
        self._observed_visible_lower_bounds = {
            f"p{index}": {
                color: 0
                for color in ["red", "blue", "green", "yellow", "black", "white", "orange", "pink", "locomotive"]
            }
            for index in range(game.number_of_players)
            if f"p{index}" != our_player_id
        }
        self._known_out_of_deck_counts = {
            color: 0
            for color in ["red", "blue", "green", "yellow", "black", "white", "orange", "pink", "locomotive"]
        }

    def observe_move(self, move, actor_seat: int, our_seat: int) -> None:
        actor_id = f"p{actor_seat}"
        our_id = f"p{our_seat}"

        if actor_id == our_id:
            return

        if actor_id not in self._observed_visible_lower_bounds:
            self._observed_visible_lower_bounds[actor_id] = {
                color: 0
                for color in ["red", "blue", "green", "yellow", "black", "white", "orange", "pink", "locomotive"]
            }

        if move.function == "drawTrainCard" and str(move.args).lower() != "top":
            color = normalize_color(str(move.args))
            self._observed_visible_lower_bounds[actor_id][color] += 1
            return

        if move.function == "claimRoute":
            color = normalize_color(str(move.args[2]))
            route = self._match_route_definition(move.args[0], move.args[1], color)
            route_length = int(route["length"]) if route else 0
            observed_available = self._observed_visible_lower_bounds[actor_id].get(color, 0)
            consumed_known = min(observed_available, route_length)

            if consumed_known > 0:
                self._observed_visible_lower_bounds[actor_id][color] -= consumed_known
                self._known_out_of_deck_counts[color] = (
                    self._known_out_of_deck_counts.get(color, 0) + consumed_known
                )

    def _build_payload(self, game, pnum: int) -> Dict:
        player_ids = [f"p{i}" for i in range(game.number_of_players)]
        player_order = player_ids[:]
        current_player_id = player_ids[game.current_player]
        our_player_id = player_ids[pnum]
        first_player_index = getattr(game, "who_went_first", 0)
        face_up_cards = []

        for color_name, count in game.train_cards_face_up.items():
            normalized = normalize_color(color_name)
            face_up_cards.extend([normalized] * int(count))

        claimed_route_ids_by_player = {player_id: [] for player_id in player_ids}
        claimed_routes = self._build_claimed_routes(game, claimed_route_ids_by_player)
        pending_ticket_ids = []
        pending_minimum_keep = None

        if game.players_choosing_destination_cards or game.players[pnum].choosing_destination_cards:
            pending_ticket_ids = [ticket_id_for_card(card) for card in game.list_pending_destination_cards(pnum)]
            pending_minimum_keep = (
                game.destination_deck_draw_rules[1]
                if game.players_choosing_destination_cards
                else game.destination_deck_draw_rules[3]
            )

        public_players = []
        beliefs = []
        for index, player in enumerate(game.players):
            player_id = player_ids[index]
            hand_count = sum(value for key, value in player.hand.items() if isinstance(value, int) and key != "destination")
            public_players.append(
                {
                    "playerId": player_id,
                    "displayName": player_id,
                    "score": int(player.points),
                    "trainsRemaining": int(player.number_of_trains),
                    "handCount": int(hand_count),
                    "claimedRouteIds": claimed_route_ids_by_player[player_id],
                    "ticketsDrawnCount": len(player.hand_destination_cards),
                }
            )
            if player_id != our_player_id:
                belief = empty_belief(player_id)
                belief["handColorLowerBounds"] = dict(self._observed_visible_lower_bounds.get(player_id, {}))
                belief["handColorExpectedCounts"] = dict(self._observed_visible_lower_bounds.get(player_id, {}))
                beliefs.append(belief)

        our_player = game.players[pnum]
        hand = {color: 0 for color in ["red", "blue", "green", "yellow", "black", "white", "orange", "pink", "locomotive"]}
        for color_name, count in our_player.hand.items():
            if color_name == "destination" or not isinstance(count, int):
                continue
            hand[normalize_color(color_name)] = int(count)

        kept_ticket_ids = [ticket_id_for_card(card) for card in our_player.hand_destination_cards]
        if pending_ticket_ids:
            our_ticket_ids = kept_ticket_ids
        else:
            our_ticket_ids = kept_ticket_ids

        if game.players[pnum].choosing_destination_cards or game.players_choosing_destination_cards:
            phase = "resolving-ticket-keep"
        elif game.players[pnum].drawing_train_cards:
            phase = "drawing-cards"
        else:
            phase = "ready"

        discard_count = int(sum(game.train_deck.discard_pile.values()))
        draw_pile_count = int(sum(game.train_deck.deck.values()))
        known_out_of_deck_counts = {}
        for color_name, count in game.train_deck.discard_pile.items():
            normalized = normalize_color(color_name)
            known_out_of_deck_counts[normalized] = known_out_of_deck_counts.get(normalized, 0) + int(count)
        for color, count in self._known_out_of_deck_counts.items():
            known_out_of_deck_counts[color] = max(known_out_of_deck_counts.get(color, 0), int(count))

        payload = {
            "gameState": {
                "rules": {
                    "extension": "base-usa",
                    "playerCount": game.number_of_players,
                    "startingTrains": 45,
                    "faceUpSlots": 5,
                    "longestRouteBonus": 10,
                    "doubleRoutesBlockedInTwoThreePlayer": game.number_of_players <= 3,
                },
                "publicState": {
                    "currentPlayerId": current_player_id,
                    "firstPlayerId": player_ids[first_player_index],
                    "turnNumber": int(sum(len(player.hand_destination_cards) for player in game.players)),
                    "phase": phase,
                    "playerOrder": player_order,
                    "players": public_players,
                    "faceUpCards": face_up_cards,
                    "discardCount": discard_count,
                    "drawPileCount": draw_pile_count,
                    "claimedRoutes": claimed_routes,
                },
                "ourState": {
                    "playerId": our_player_id,
                    "trainsRemaining": int(our_player.number_of_trains),
                    "hand": hand,
                    "ticketIds": our_ticket_ids,
                },
                "beliefs": beliefs,
                "pendingTicketChoice": (
                    {
                        "playerId": our_player_id,
                        "offeredTicketIds": pending_ticket_ids,
                        "minimumKeepCount": pending_minimum_keep,
                    }
                    if pending_ticket_ids
                    else None
                ),
                "annotations": {
                    "activePlanTags": [],
                    "securedTicketIds": [],
                    "atRiskTicketIds": [],
                    "bottleneckRouteIds": [],
                    "knownOutOfDeckCounts": known_out_of_deck_counts,
                },
            }
        }

        if self.policy_model_path:
            payload["policyModelPath"] = self.policy_model_path
            payload["heuristicWeight"] = self.heuristic_weight
            payload["learnedWeight"] = self.learned_weight

        return payload

    def _build_claimed_routes(self, game, claimed_route_ids_by_player: Dict[str, List[str]]) -> Dict[str, str]:
        route_buckets: Dict[Tuple[str, str, str, int], List[str]] = {}
        for route in self._usa_routes():
            signature = self._route_signature_from_internal(route)
            route_buckets.setdefault(signature, []).append(route["id"])

        claimed_routes: Dict[str, str] = {}
        visited = set()
        for city_a in game.board.graph:
            for city_b in game.board.graph[city_a]:
                pair_key = tuple(sorted((city_a, city_b)))
                if pair_key in visited:
                    continue
                visited.add(pair_key)

                for edge_key in game.board.graph[city_a][city_b]:
                    edge = game.board.graph[city_a][city_b][edge_key]
                    owner = int(edge["owner"])
                    if owner < 0:
                        continue

                    signature = route_signature(city_a, city_b, edge["color"].lower(), int(edge["weight"]))
                    bucket = route_buckets.get(signature)
                    if not bucket:
                        continue

                    route_id = bucket.pop(0)
                    claimed_routes[route_id] = f"p{owner}"
                    claimed_route_ids_by_player[f"p{owner}"].append(route_id)

        return claimed_routes

    def _route_signature_from_internal(self, route: Dict) -> Tuple[str, str, str, int]:
        ordered = tuple(sorted((route["cityA"], route["cityB"])))
        return ordered[0], ordered[1], route["color"], int(route["length"])

    def _usa_routes(self) -> List[Dict]:
        if hasattr(self, "_cached_routes"):
            return self._cached_routes

        self._cached_routes = self._worker.request("get-usa-routes")
        return self._cached_routes

    @property
    def node_executable(self) -> str:
        return self._node_executable

    @node_executable.setter
    def node_executable(self, value: str) -> None:
        self._node_executable = value

    def _match_external_move(self, game, pnum, possible_moves, action: Optional[Dict]):
        if not action:
            return None

        for move in possible_moves:
            if action["kind"] == "draw-blind":
                if move.function == "drawTrainCard" and move.args == "top":
                    return move

            elif action["kind"] == "draw-face-up":
                if move.function == "drawTrainCard" and str(move.args).lower() != "top" and normalize_color(str(move.args)) == action["color"]:
                    return move

            elif action["kind"] == "draw-tickets":
                if move.function == "drawDestinationCards":
                    return move

            elif action["kind"] == "keep-tickets":
                if move.function != "chooseDestinationCards":
                    continue
                move_keys = sorted(ticket_id_for_card(card) for card in move.args[1])
                action_keys = sorted(action["keptTicketIds"])
                if move_keys == action_keys:
                    return move

            elif action["kind"] == "claim-route":
                if move.function != "claimRoute":
                    continue
                if self._move_matches_claim_action(move, action):
                    return move

        return None

    def _recover_when_no_possible_moves(self, game, pnum, possible_moves):
        if possible_moves:
            return None

        from ttrengine import Move

        player = game.players[pnum]
        pending_cards = game.list_pending_destination_cards(pnum)

        if game.players_choosing_destination_cards or player.choosing_destination_cards:
            minimum_keep = (
                game.destination_deck_draw_rules[1]
                if game.players_choosing_destination_cards
                else game.destination_deck_draw_rules[3]
            )
            if len(pending_cards) >= minimum_keep:
                return Move("chooseDestinationCards", [pnum, list(pending_cards[:minimum_keep])])

        if player.drawing_train_cards:
            non_wild_face_up = [
                card_name
                for card_name, count in game.train_cards_face_up.items()
                if count > 0 and str(card_name).lower() != "wild"
            ]
            if non_wild_face_up:
                return Move("drawTrainCard", non_wild_face_up[0])

            if sum(game.train_deck.deck.values()) > 0 or sum(game.train_deck.discard_pile.values()) > 0:
                return Move("drawTrainCard", "top")

            any_face_up = [card_name for card_name, count in game.train_cards_face_up.items() if count > 0]
            if any_face_up:
                return Move("drawTrainCard", any_face_up[0])

        if sum(game.destination_deck.deck.values()) > 0:
            return Move("drawDestinationCards", [])

        if sum(game.train_deck.deck.values()) > 0 or sum(game.train_deck.discard_pile.values()) > 0:
            return Move("drawTrainCard", "top")

        any_face_up = [card_name for card_name, count in game.train_cards_face_up.items() if count > 0]
        if any_face_up:
            return Move("drawTrainCard", any_face_up[0])

        return None

    def _build_empty_move_state_error(self, game, pnum: int, recommendation: Dict) -> str:
        player = game.players[pnum]
        state_summary = {
            "playerIndex": pnum,
            "currentPlayer": game.current_player,
            "playersChoosingDestinationCards": game.players_choosing_destination_cards,
            "playerChoosingDestinationCards": player.choosing_destination_cards,
            "playerDrawingTrainCards": player.drawing_train_cards,
            "drawPileCount": int(sum(game.train_deck.deck.values())),
            "discardPileCount": int(sum(game.train_deck.discard_pile.values())),
            "faceUpCards": {key: int(value) for key, value in game.train_cards_face_up.items() if int(value) > 0},
            "pendingDestinationCount": len(game.list_pending_destination_cards(pnum)),
            "topRationale": recommendation.get("topRationale", []),
        }
        return f"External engine produced no possible moves for Codex solver: {json.dumps(state_summary)}"

    def _move_matches_claim_action(self, move, action: Dict) -> bool:
        route = self._route_lookup_by_id(action["routeId"])
        if route is None:
            return False

        move_city_a = normalize_city(move.args[0])
        move_city_b = normalize_city(move.args[1])
        action_pair = sorted((route["cityA"], route["cityB"]))
        move_pair = sorted((move_city_a, move_city_b))
        if action_pair != move_pair:
            return False

        move_color = normalize_color(str(move.args[2]))
        return move_color == action["payment"]["primaryColor"]

    def _match_route_definition(self, city_a: str, city_b: str, color: str) -> Optional[Dict]:
        normalized_pair = sorted((normalize_city(city_a), normalize_city(city_b)))
        for route in self._usa_routes():
            route_pair = sorted((route["cityA"], route["cityB"]))
            if route_pair != normalized_pair:
                continue
            if route["color"] == "gray" or route["color"] == color:
                return route
        return None

    def _route_lookup_by_id(self, route_id: str) -> Optional[Dict]:
        for route in self._usa_routes():
            if route["id"] == route_id:
                return route
        return None
