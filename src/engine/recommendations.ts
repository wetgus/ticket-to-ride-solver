import type {
  ClaimRouteAction,
  DrawBlindAction,
  DrawFaceUpAction,
  DrawTicketsAction,
  GameAction
} from "../model/actions.js";
import type {
  ActionRecommendation,
  EvaluationFeatures,
  PositionEvaluation,
  RouteUrgencyEstimate,
  TicketCompletionEstimate,
  TurnEvaluation,
  TurnRecommendation
} from "../model/evaluation.js";
import type {
  BoardDefinition,
  RouteDefinition,
  RouteId,
  TicketDefinition,
  TrainColor
} from "../model/board.js";
import { TRAIN_COLORS } from "../model/board.js";
import type { GameState, PublicGameState } from "../model/game-state.js";
import { applyOwnRouteClaim } from "./claiming.js";
import { areCitiesConnected, getLongestRouteLength } from "./connectivity.js";
import { indexRoutesById, indexRoutesByParallelGroup } from "./board-index.js";
import { getLegalClaimRouteActions } from "./legal-actions.js";

interface PathStep {
  routeId: RouteId;
  cityA: string;
  cityB: string;
  length: number;
  color: RouteDefinition["color"];
}

interface TicketPathEvaluation {
  distance: number;
  path: PathStep[];
}

interface TicketProgressState {
  ticket: TicketDefinition;
  distance: number;
  path: PathStep[];
  completed: boolean;
}

const NON_LOCOMOTIVE_COLORS: Array<Exclude<TrainColor, "locomotive">> = [
  "red",
  "blue",
  "green",
  "yellow",
  "black",
  "white",
  "orange",
  "pink"
];

const TRAIN_DECK_COUNTS: Record<TrainColor, number> = {
  red: 12,
  blue: 12,
  green: 12,
  yellow: 12,
  black: 12,
  white: 12,
  orange: 12,
  pink: 12,
  locomotive: 14
};

const BLIND_DRAW_OUTCOME_LIMIT = 4;

const getPlayerPublicState = (gameState: GameState) => {
  const player = gameState.publicState.players.find(
    (candidate) => candidate.playerId === gameState.ourState.playerId
  );

  if (!player) {
    throw new Error("Could not find current player in public player state.");
  }

  return player;
};

interface DeploymentPressureEstimate {
  drawPenalty: number;
  claimBonus: number;
  knownHandSize: number;
  maxColorStack: number;
  claimedRouteCount: number;
  readyClaimCount: number;
  readyLongClaimCount: number;
  signals: string[];
}

const getKnownHandSize = (gameState: GameState): number =>
  TRAIN_COLORS.reduce((sum, color) => sum + (gameState.ourState.hand[color] ?? 0), 0);

const estimateDeploymentPressure = (
  board: BoardDefinition,
  gameState: GameState
): DeploymentPressureEstimate => {
  const knownHandSize = getKnownHandSize(gameState);
  const publicPlayer = getPlayerPublicState(gameState);
  const claimedRouteCount = publicPlayer.claimedRouteIds.length;
  const maxColorStack = Math.max(
    ...NON_LOCOMOTIVE_COLORS.map((color) => gameState.ourState.hand[color] ?? 0)
  );
  const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);
  const legalClaims = getLegalClaimRouteActions(gameState, board.routes, routesByParallelGroup);
  const readyClaimCount = legalClaims.length;
  const readyLongClaimCount = legalClaims.filter((action) => {
    const route = board.routes.find((candidate) => candidate.id === action.routeId);
    return (route?.length ?? 0) >= 5;
  }).length;
  const cardToTrainOverhang = Math.max(0, knownHandSize - publicPlayer.trainsRemaining);

  let oversizedHandPenalty = 0;
  if (knownHandSize > 32) {
    oversizedHandPenalty = 18 + (knownHandSize - 32) * 3.4;
  } else if (knownHandSize > 28) {
    oversizedHandPenalty = 5 + (knownHandSize - 28) * 1.7;
  } else if (knownHandSize > 24) {
    oversizedHandPenalty = (knownHandSize - 24) * 0.7;
  } else if (knownHandSize > 20 && claimedRouteCount >= 2) {
    oversizedHandPenalty = 1.2 + (knownHandSize - 20) * 0.85;
  }

  if (claimedRouteCount === 0 && knownHandSize > 22) {
    oversizedHandPenalty += (knownHandSize - 22) * 0.55;
  } else if (claimedRouteCount <= 1 && knownHandSize > 20) {
    oversizedHandPenalty += (knownHandSize - 20) * 0.45;
  }
  if (cardToTrainOverhang > 0) {
    oversizedHandPenalty +=
      cardToTrainOverhang * (claimedRouteCount <= 1 ? 2.15 : 1.8) +
      Math.max(0, cardToTrainOverhang - 2) * 1.95;
  }
  if (claimedRouteCount >= 2 && knownHandSize >= publicPlayer.trainsRemaining - 2) {
    oversizedHandPenalty +=
      (knownHandSize - (publicPlayer.trainsRemaining - 2) + 1) *
      1.45;
  }
  if (readyClaimCount > 0 && knownHandSize > 20 && claimedRouteCount >= 1) {
    oversizedHandPenalty += (knownHandSize - 20) * (readyLongClaimCount > 0 ? 1.05 : 0.72);
  }

  const locomotiveCount = gameState.ourState.hand.locomotive ?? 0;
  const colorOverflow = Math.max(0, maxColorStack - 6);
  const locomotiveOverflow = Math.max(0, locomotiveCount - 6);
  let stackPenalty =
    colorOverflow * (claimedRouteCount === 0 ? 1.35 : 0.72) +
    locomotiveOverflow * (claimedRouteCount === 0 ? 1.55 : 0.85);

  let readyClaimPressure = 0;
  if (readyLongClaimCount > 0 && (knownHandSize >= 18 || claimedRouteCount >= 2)) {
    readyClaimPressure += claimedRouteCount === 0 ? 2.4 : 4.3;
  } else if (readyClaimCount > 0 && knownHandSize >= 20) {
    readyClaimPressure += claimedRouteCount === 0 ? 0.9 : 2.1;
  }

  const signals: string[] = [];
  if (knownHandSize > 28) {
    signals.push(`hand is already very large at ${knownHandSize} cards`);
  }
  if (colorOverflow > 0) {
    signals.push(`one color stack is already bloated at ${maxColorStack} cards`);
  }
    if (locomotiveOverflow > 0) {
      signals.push(`locomotive stack is already bloated at ${locomotiveCount} cards`);
    }
    if (cardToTrainOverhang > 0) {
      signals.push(
        `hand already exceeds remaining trains by ${cardToTrainOverhang} card${cardToTrainOverhang > 1 ? "s" : ""}`
      );
    }
  if (claimedRouteCount >= 1 && readyLongClaimCount > 0 && knownHandSize >= 18) {
    signals.push("a long route is already claimable, so continuing to draw is expensive");
  }

  const drawPenalty = oversizedHandPenalty + stackPenalty + readyClaimPressure;
  const claimBonus =
    oversizedHandPenalty * 0.45 + stackPenalty * 0.42 + readyClaimPressure * 0.75;

  return {
    drawPenalty,
    claimBonus,
    knownHandSize,
    maxColorStack,
    claimedRouteCount,
    readyClaimCount,
    readyLongClaimCount,
    signals
  };
};

const getOurTickets = (
  board: BoardDefinition,
  gameState: GameState
): TicketDefinition[] => {
  const ticketIds = new Set(gameState.ourState.ticketIds);
  return board.tickets.filter((ticket) => ticketIds.has(ticket.id));
};

const getUnknownTickets = (
  board: BoardDefinition,
  gameState: GameState
): TicketDefinition[] => {
  const ownedTicketIds = new Set(gameState.ourState.ticketIds);

  if (gameState.pendingTicketChoice) {
    for (const ticketId of gameState.pendingTicketChoice.offeredTicketIds) {
      ownedTicketIds.add(ticketId);
    }
  }

  return board.tickets.filter((ticket) => !ownedTicketIds.has(ticket.id));
};

const getCityName = (board: BoardDefinition, cityId: string): string =>
  board.cities.find((city) => city.id === cityId)?.name ?? cityId;

const getCityRegion = (board: BoardDefinition, cityId: string): string | undefined =>
  board.cities.find((city) => city.id === cityId)?.region;

const formatTicketLabel = (board: BoardDefinition, ticket: TicketDefinition): string =>
  `${getCityName(board, ticket.fromCity)} - ${getCityName(board, ticket.toCity)}`;

const getAvailableRoutes = (
  board: BoardDefinition,
  publicState: PublicGameState,
  playerId: string
): PathStep[] =>
  board.routes
    .filter((route) => {
      const owner = publicState.claimedRoutes[route.id];
      return !owner || owner === playerId;
    })
    .map((route) => ({
      routeId: route.id,
      cityA: route.cityA,
      cityB: route.cityB,
      length: route.length,
      color: route.color
    }));

const TICKET_FAMILIES: TicketDefinition["family"][] = [
  "transcontinental",
  "north-south",
  "east-cluster",
  "west-cluster",
  "central-connector",
  "southwest-pivot",
  "canada-border"
];

const routeTouchesRegion = (
  board: BoardDefinition,
  route: Pick<RouteDefinition, "cityA" | "cityB">,
  region: string
): boolean =>
  getCityRegion(board, route.cityA) === region || getCityRegion(board, route.cityB) === region;

const routeTouchesCity = (
  route: Pick<RouteDefinition, "cityA" | "cityB">,
  cityId: string
): boolean => route.cityA === cityId || route.cityB === cityId;

const getTicketFamilyRouteRelevance = (
  board: BoardDefinition,
  route: RouteDefinition,
  family: TicketDefinition["family"]
): number => {
  switch (family) {
    case "transcontinental": {
      const westTouch =
        routeTouchesRegion(board, route, "west") ||
        routeTouchesRegion(board, route, "northwest") ||
        routeTouchesRegion(board, route, "southwest");
      const eastOrMidTouch =
        routeTouchesRegion(board, route, "northeast") ||
        routeTouchesRegion(board, route, "midwest") ||
        routeTouchesRegion(board, route, "central") ||
        routeTouchesRegion(board, route, "south");

      return westTouch && eastOrMidTouch
        ? 1
        : westTouch || eastOrMidTouch
          ? route.length >= 5
            ? 0.75
            : 0.45
          : route.length >= 6
            ? 0.25
            : 0;
    }
    case "north-south":
      return routeTouchesRegion(board, route, "northwest") ||
        routeTouchesRegion(board, route, "south") ||
        routeTouchesRegion(board, route, "southwest")
        ? route.length >= 4
          ? 0.9
          : 0.55
        : 0.15;
    case "east-cluster":
      return routeTouchesRegion(board, route, "northeast") ||
        routeTouchesCity(route, "atlanta") ||
        routeTouchesCity(route, "miami") ||
        routeTouchesCity(route, "raleigh") ||
        routeTouchesCity(route, "charleston")
        ? 0.95
        : 0.12;
    case "west-cluster":
      return routeTouchesRegion(board, route, "west") ||
        routeTouchesRegion(board, route, "northwest") ||
        routeTouchesRegion(board, route, "southwest")
        ? 0.95
        : 0.1;
    case "central-connector":
      return routeTouchesRegion(board, route, "central") ||
        routeTouchesRegion(board, route, "midwest") ||
        routeTouchesCity(route, "oklahoma-city") ||
        routeTouchesCity(route, "kansas-city") ||
        routeTouchesCity(route, "saint-louis") ||
        routeTouchesCity(route, "omaha") ||
        routeTouchesCity(route, "duluth")
        ? 0.95
        : 0.16;
    case "southwest-pivot":
      return routeTouchesCity(route, "denver") ||
        routeTouchesCity(route, "el-paso") ||
        routeTouchesCity(route, "phoenix") ||
        routeTouchesCity(route, "santa-fe") ||
        routeTouchesCity(route, "oklahoma-city")
        ? 1
        : 0.08;
    case "canada-border":
      return routeTouchesCity(route, "vancouver") ||
        routeTouchesCity(route, "calgary") ||
        routeTouchesCity(route, "winnipeg") ||
        routeTouchesCity(route, "sault-st-marie") ||
        routeTouchesCity(route, "montreal") ||
        routeTouchesCity(route, "toronto")
        ? 1
        : routeTouchesCity(route, "duluth")
          ? 0.45
          : 0.05;
    default:
      return 0.1;
  }
};

const getOpponentPressureForRoute = (
  board: BoardDefinition,
  route: RouteDefinition,
  gameState: GameState
): {
  pressureBoost: number;
  signals: string[];
} => {
  let pressureBoost = 0;
  const signals: string[] = [];

  for (const belief of gameState.beliefs) {
    for (const familyRead of belief.ticketFamilyPosterior) {
      const relevance = getTicketFamilyRouteRelevance(board, route, familyRead.family);
      const contribution = familyRead.weight * relevance;

      if (contribution < 0.18) {
        continue;
      }

      pressureBoost += contribution * 0.22;
      if (signals.length < 3) {
        signals.push(
          `${belief.playerId} likely on ${familyRead.family.replaceAll("-", " ")} tickets`
        );
      }
    }

    for (const corridor of belief.corridorInterest) {
      const corridorMatches =
        corridor.corridorId === route.id ||
        corridor.corridorId === route.parallelGroup ||
        route.tags.includes(corridor.corridorId) ||
        route.cityA === corridor.corridorId ||
        route.cityB === corridor.corridorId;

      if (!corridorMatches || corridor.weight < 0.2) {
        continue;
      }

      pressureBoost += corridor.weight * 0.3;
      if (signals.length < 3) {
        signals.push(`${belief.playerId} showing interest in ${corridor.corridorId}`);
      }
    }
  }

  return {
    pressureBoost: Math.min(0.32, pressureBoost),
    signals
  };
};

const getEffectiveBeliefs = (
  board: BoardDefinition,
  gameState: GameState
): GameState["beliefs"] =>
  gameState.beliefs.map((belief) => {
    const publicPlayer = gameState.publicState.players.find(
      (player) => player.playerId === belief.playerId
    );
    const claimedRoutes = board.routes.filter((route) =>
      publicPlayer?.claimedRouteIds.includes(route.id)
    );

    const inferredTicketFamilies =
      belief.ticketFamilyPosterior.length > 0
        ? belief.ticketFamilyPosterior
        : TICKET_FAMILIES
            .map((family) => {
              const weight = claimedRoutes.reduce(
                (sum, route) => sum + getTicketFamilyRouteRelevance(board, route, family),
                0
              );
              return {
                family,
                weight,
                supportingEvidence: claimedRoutes.slice(0, 2).map((route) => route.id)
              };
            })
            .filter((entry) => entry.weight > 0.2)
            .sort((left, right) => right.weight - left.weight)
            .slice(0, 3)
            .map((entry) => ({
              family: entry.family,
              weight: Math.min(0.95, entry.weight / Math.max(1, claimedRoutes.length * 1.4)),
              supportingEvidence: entry.supportingEvidence
            }));

    const inferredCorridors =
      belief.corridorInterest.length > 0
        ? belief.corridorInterest
        : claimedRoutes.slice(0, 4).map((route) => ({
            corridorId: route.parallelGroup ?? route.id,
            weight: route.length >= 5 ? 0.8 : route.length >= 3 ? 0.55 : 0.35,
            evidence: [route.cityA, route.cityB]
          }));

    return {
      ...belief,
      ticketFamilyPosterior: inferredTicketFamilies,
      corridorInterest: inferredCorridors
    };
  });

const buildCityGraph = (routes: PathStep[]): Map<string, PathStep[]> => {
  const adjacency = new Map<string, PathStep[]>();

  for (const route of routes) {
    adjacency.set(route.cityA, [...(adjacency.get(route.cityA) ?? []), route]);
    adjacency.set(route.cityB, [...(adjacency.get(route.cityB) ?? []), route]);
  }

  return adjacency;
};

const reconstructPath = (
  predecessors: Map<string, { previousCity: string; route: PathStep }>,
  targetCity: string
): PathStep[] => {
  const path: PathStep[] = [];
  let cursor = targetCity;

  while (predecessors.has(cursor)) {
    const step = predecessors.get(cursor);

    if (!step) {
      break;
    }

    path.unshift(step.route);
    cursor = step.previousCity;
  }

  return path;
};

const evaluateTicketPath = (
  board: BoardDefinition,
  publicState: PublicGameState,
  playerId: string,
  ticket: TicketDefinition
): TicketPathEvaluation => {
  if (
    areCitiesConnected(
      publicState,
      playerId,
      ticket.fromCity,
      ticket.toCity,
      indexRoutesById(board.routes)
    )
  ) {
    return { distance: 0, path: [] };
  }

  const availableRoutes = getAvailableRoutes(board, publicState, playerId);
  const adjacency = buildCityGraph(availableRoutes);
  const distances = new Map<string, number>([[ticket.fromCity, 0]]);
  const predecessors = new Map<string, { previousCity: string; route: PathStep }>();
  const queue = new Set<string>([ticket.fromCity]);

  while (queue.size > 0) {
    let currentCity: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;

    for (const city of queue) {
      const candidateDistance = distances.get(city) ?? Number.POSITIVE_INFINITY;
      if (candidateDistance < currentDistance) {
        currentDistance = candidateDistance;
        currentCity = city;
      }
    }

    if (!currentCity) {
      break;
    }

    queue.delete(currentCity);

    if (currentCity === ticket.toCity) {
      return {
        distance: currentDistance,
        path: reconstructPath(predecessors, ticket.toCity)
      };
    }

    for (const route of adjacency.get(currentCity) ?? []) {
      const nextCity = route.cityA === currentCity ? route.cityB : route.cityA;
      const nextDistance = currentDistance + route.length;

      if (nextDistance < (distances.get(nextCity) ?? Number.POSITIVE_INFINITY)) {
        distances.set(nextCity, nextDistance);
        predecessors.set(nextCity, {
          previousCity: currentCity,
          route
        });
        queue.add(nextCity);
      }
    }
  }

  return {
    distance: Number.POSITIVE_INFINITY,
    path: []
  };
};

const getTicketProgressStates = (
  board: BoardDefinition,
  gameState: GameState
): TicketProgressState[] =>
  getOurTickets(board, gameState).map((ticket) => {
    const pathEvaluation = evaluateTicketPath(
      board,
      gameState.publicState,
      gameState.ourState.playerId,
      ticket
    );

    return {
      ticket,
      distance: pathEvaluation.distance,
      path: pathEvaluation.path,
      completed: pathEvaluation.distance === 0
    };
  });

const evaluateTickets = (
  board: BoardDefinition,
  gameState: GameState
): {
  tickets: TicketCompletionEstimate[];
  totalExpectedTicketValue: number;
  pathDemand: Map<TrainColor, number>;
} => {
  const routesById = indexRoutesById(board.routes);
  const activeTickets = getOurTickets(board, gameState);
  const pathDemand = new Map<TrainColor, number>();

  const tickets = activeTickets.map((ticket) => {
    const pathEvaluation = evaluateTicketPath(
      board,
      gameState.publicState,
      gameState.ourState.playerId,
      ticket
    );
    const completed = pathEvaluation.distance === 0;
    const viablePathCount = pathEvaluation.distance === Number.POSITIVE_INFINITY ? 0 : 1;
    const completionProbability = completed
      ? 1
      : pathEvaluation.distance === Number.POSITIVE_INFINITY
        ? 0
        : Math.max(0.1, Math.min(0.95, 1 - pathEvaluation.distance / 20));
    const expectedValue = ticket.points * completionProbability;

    for (const step of pathEvaluation.path) {
      if (step.color === "gray") {
        continue;
      }

      pathDemand.set(step.color, (pathDemand.get(step.color) ?? 0) + step.length);
    }

    return {
      ticketId: ticket.id,
      completionProbability,
      expectedValue,
      trainsRequiredLowerBound:
        pathEvaluation.distance === Number.POSITIVE_INFINITY ? 99 : pathEvaluation.distance,
      viablePathCount,
      bottleneckRouteIds: pathEvaluation.path
        .filter((step) => step.length >= 5)
        .map((step) => step.routeId)
        .filter((routeId) => routesById.has(routeId))
    };
  });

  return {
    tickets,
    totalExpectedTicketValue: tickets.reduce((sum, ticket) => sum + ticket.expectedValue, 0),
    pathDemand
  };
};

const getRouteUrgency = (
  board: BoardDefinition,
  gameState: GameState
): RouteUrgencyEstimate[] => {
  const tickets = getOurTickets(board, gameState);
  const urgentRoutes = new Map<RouteId, RouteUrgencyEstimate>();
  const routesById = indexRoutesById(board.routes);
  const effectiveGameState = {
    ...gameState,
    beliefs: getEffectiveBeliefs(board, gameState)
  };

  for (const ticket of tickets) {
    const pathEvaluation = evaluateTicketPath(
      board,
      gameState.publicState,
      gameState.ourState.playerId,
      ticket
    );

    for (const step of pathEvaluation.path) {
      const supportingSignals: string[] = [];
      const route = routesById.get(step.routeId);

      if (step.length >= 5) {
        supportingSignals.push("long critical segment");
      }

      if (gameState.annotations.bottleneckRouteIds.includes(step.routeId)) {
        supportingSignals.push("annotated bottleneck");
      }

      const opponentPressure = route
        ? getOpponentPressureForRoute(board, route, effectiveGameState)
        : { pressureBoost: 0, signals: [] as string[] };
      supportingSignals.push(...opponentPressure.signals);

      if (supportingSignals.length === 0) {
        continue;
      }

      urgentRoutes.set(step.routeId, {
        routeId: step.routeId,
        loseBeforeNextTurnProbability: Math.min(
          0.85,
          0.2 +
            step.length * 0.08 +
            supportingSignals.length * 0.08 +
            opponentPressure.pressureBoost
        ),
        supportingSignals
      });
    }
  }

  return [...urgentRoutes.values()].sort(
    (left, right) => right.loseBeforeNextTurnProbability - left.loseBeforeNextTurnProbability
  );
};

const estimateTicketDetourExposure = (
  board: BoardDefinition,
  gameState: GameState,
  routeUrgency: RouteUrgencyEstimate[]
): number => {
  const urgencyByRoute = new Map(
    routeUrgency.map((entry) => [entry.routeId, entry.loseBeforeNextTurnProbability])
  );

  return getTicketProgressStates(board, gameState).reduce((sum, ticketState) => {
    if (ticketState.distance === Number.POSITIVE_INFINITY) {
      return sum + 12;
    }

    const pathPenalty = ticketState.path.reduce((pathSum, step) => {
      const urgency = urgencyByRoute.get(step.routeId) ?? 0;
      const annotatedBottleneck = gameState.annotations.bottleneckRouteIds.includes(step.routeId)
        ? 0.35
        : 0;
      const longStepPenalty = step.length >= 5 ? 0.2 : 0;

      return pathSum + step.length * (urgency + annotatedBottleneck + longStepPenalty);
    }, 0);

    const lowRedundancyPenalty = ticketState.path.length <= 3 ? 1.4 : ticketState.path.length <= 5 ? 0.8 : 0.3;
    return sum + pathPenalty + lowRedundancyPenalty;
  }, 0);
};

const estimateActionClockPressureImpact = (
  endgameClock: ReturnType<typeof estimateEndgameClock>,
  actionKind: GameAction["kind"],
  routeLength = 0
): number => {
  const pressureBase = endgameClock.immediateTriggerRisk * 5.5 + endgameClock.nearTermTriggerRisk * 2.8;

  if (actionKind === "claim-route") {
    return pressureBase + routeLength * 0.45 + endgameClock.selfTriggerChance * 1.6;
  }

  if (actionKind === "draw-tickets") {
    return -(pressureBase * 1.25 + 0.8);
  }

  return -(pressureBase * 0.95);
};

const createBlankFeatures = (): EvaluationFeatures => ({
  expectedFinalScore: 0,
  winProbabilityEstimate: 0,
  scoreDiffEstimate: 0,
  routeValue: 0,
  ticketValue: 0,
  tempoValue: 0,
  flexibilityValue: 0,
  riskCost: 0,
  blockExposure: 0,
  trainsRemainingPressure: 0,
  opponentClockPressure: 0,
  bottleneckUrgency: 0,
  ticketDetourPenalty: 0
});

const getCurrentTicketGap = (
  board: BoardDefinition,
  gameState: GameState
): number =>
  getTicketProgressStates(board, gameState).reduce(
    (sum, ticketState) =>
      sum + (ticketState.distance === Number.POSITIVE_INFINITY ? 20 : ticketState.distance),
    0
  );

const countCompletedTickets = (
  board: BoardDefinition,
  gameState: GameState
): number => {
  const routesById = indexRoutesById(board.routes);

  return getOurTickets(board, gameState).filter((ticket) =>
    areCitiesConnected(
      gameState.publicState,
      gameState.ourState.playerId,
      ticket.fromCity,
      ticket.toCity,
      routesById
    )
  ).length;
};

const getLongestRouteForState = (
  board: BoardDefinition,
  gameState: GameState
): number =>
  getLongestRouteLength(
    gameState.publicState,
    gameState.ourState.playerId,
    indexRoutesById(board.routes)
  );

const getNeededColorWeight = (
  color: TrainColor,
  colorDemand: Map<TrainColor, number>,
  hand: GameState["ourState"]["hand"]
): number => {
  if (color === "locomotive") {
    return NON_LOCOMOTIVE_COLORS.reduce(
      (sum, candidateColor) =>
        sum + Math.max(0, (colorDemand.get(candidateColor) ?? 0) - (hand[candidateColor] ?? 0)),
      0
    );
  }

  return Math.max(0, (colorDemand.get(color) ?? 0) - (hand[color] ?? 0));
};

const getUnmetColorDemand = (
  colorDemand: Map<TrainColor, number>,
  hand: GameState["ourState"]["hand"]
): Array<{ color: TrainColor; unmet: number }> =>
  NON_LOCOMOTIVE_COLORS.map((color) => ({
    color,
    unmet: Math.max(0, (colorDemand.get(color) ?? 0) - (hand[color] ?? 0))
  }))
    .filter((entry) => entry.unmet > 0)
    .sort((left, right) => right.unmet - left.unmet);

const getDrawTacticProfile = (
  colorDemand: Map<TrainColor, number>,
  hand: GameState["ourState"]["hand"],
  claimedRouteCount: number
): {
  mode: "value" | "focus";
  priorityColors: Set<TrainColor>;
  concentration: number;
  topUnmet: number;
} => {
  const unmet = getUnmetColorDemand(colorDemand, hand);
  const totalUnmet = unmet.reduce((sum, entry) => sum + entry.unmet, 0);
  const topUnmet = unmet[0]?.unmet ?? 0;
  const secondUnmet = unmet[1]?.unmet ?? 0;
  const knownHandSize = TRAIN_COLORS.reduce((sum, color) => sum + (hand[color] ?? 0), 0);
  const concentration =
    totalUnmet > 0 ? (topUnmet + secondUnmet) / totalUnmet : 0;
  const priorityColors = new Set(
    unmet
      .slice(0, 2)
      .filter((entry) => entry.unmet >= Math.max(2, topUnmet * 0.45))
      .map((entry) => entry.color)
  );
  const mode =
    totalUnmet === 0
      ? "value"
      : claimedRouteCount === 0 && knownHandSize < 20 && topUnmet < 5 && concentration < 0.78
        ? "value"
        : claimedRouteCount <= 1 && knownHandSize < 18 && topUnmet < 4 && concentration < 0.72
          ? "value"
        : claimedRouteCount >= 3
          ? "focus"
          : topUnmet >= 5 || concentration >= 0.74
          ? "focus"
          : "value";

  return {
    mode,
    priorityColors,
    concentration,
    topUnmet
  };
};

const getCommittedTicketPathColors = (
  currentTicketStates: TicketProgressState[],
  hand: GameState["ourState"]["hand"]
): Set<TrainColor> => {
  const colors = new Set<TrainColor>();
  const locomotives = hand.locomotive ?? 0;

  for (const ticketState of currentTicketStates) {
    if (ticketState.completed) {
      continue;
    }

    for (const step of ticketState.path) {
      if (step.color === "gray") {
        continue;
      }

      const pureColorCount = hand[step.color] ?? 0;
      const available = pureColorCount + locomotives;
      const missing = Math.max(0, step.length - available);

      if (pureColorCount >= 2 || missing <= 2) {
        colors.add(step.color);
      }
    }
  }

  return colors;
};

const getColorTicketPlanPressure = (
  currentTicketStates: TicketProgressState[],
  hand: GameState["ourState"]["hand"],
  color: TrainColor
): number => {
  if (color === "locomotive") {
    return 0;
  }

  const locomotives = hand.locomotive ?? 0;
  return currentTicketStates.reduce((sum, ticketState) => {
    if (ticketState.completed) {
      return sum;
    }

    const bestStepPressure = ticketState.path.reduce((best, step) => {
      if (step.color !== color && step.color !== "gray") {
        return best;
      }

      const available = (hand[color] ?? 0) + locomotives;
      const missing = Math.max(0, step.length - available);
      const pathWeight = 1 / Math.max(1, ticketState.path.length);
      const distanceWeight =
        ticketState.distance <= 4 ? 1.7 : ticketState.distance <= 7 ? 1.25 : 0.9;
      const grayWeight = step.color === "gray" ? 0.82 : 1;
      const pressure =
        missing <= 0
          ? 1.4 * distanceWeight * pathWeight * grayWeight
          : missing === 1
            ? 4.8 * distanceWeight * pathWeight * grayWeight
            : missing === 2
              ? 2.2 * distanceWeight * pathWeight * grayWeight
              : 0.45 * distanceWeight * pathWeight * grayWeight;

      return Math.max(best, pressure);
    }, 0);

    return sum + bestStepPressure;
  }, 0);
};

export interface ColorPriorityEstimate {
  color: TrainColor;
  score: number;
  visibleCount: number;
  rationale: string[];
}

export const rankColorPriorities = (
  gameState: GameState,
  board: BoardDefinition
): ColorPriorityEstimate[] => {
  const ticketEvaluation = evaluateTickets(board, gameState);
  const currentTicketStates = getTicketProgressStates(board, gameState);
  const committedPathColors = getCommittedTicketPathColors(
    currentTicketStates,
    gameState.ourState.hand
  );
  const publicPlayer = getPlayerPublicState(gameState);
  const drawTactic = getDrawTacticProfile(
    ticketEvaluation.pathDemand,
    gameState.ourState.hand,
    publicPlayer.claimedRouteIds.length
  );

  return TRAIN_COLORS.map((color) => {
    const neededWeight = getNeededColorWeight(
      color,
      ticketEvaluation.pathDemand,
      gameState.ourState.hand
    );
    const ticketPlanPressure = getColorTicketPlanPressure(
      currentTicketStates,
      gameState.ourState.hand,
      color
    );
    const visibleCount = gameState.publicState.faceUpCards.filter(
      (candidate) => candidate === color
    ).length;
    const committedBonus = committedPathColors.has(color) ? 1.8 : 0;
    const visibleBonus = visibleCount * (color === "locomotive" ? 0.55 : 0.85);
    const score =
      neededWeight * (color === "locomotive" ? 0.9 : 1.15) +
      ticketPlanPressure * (color === "locomotive" ? 0.65 : 1.55) +
      committedBonus +
      visibleBonus;
    const rationale = [
      neededWeight > 0
        ? `unmet route-color demand ${neededWeight.toFixed(1)}`
        : "little direct unmet route-color demand",
      ticketPlanPressure > 0
        ? `ticket-path pressure ${ticketPlanPressure.toFixed(1)}`
        : "low immediate ticket-path pressure",
      committedPathColors.has(color)
        ? "already invested in this color on active ticket paths"
        : "not yet a committed ticket-path color",
      visibleCount > 0
        ? `${visibleCount} visible in the pool right now`
        : "not currently visible in the pool"
    ];

    return {
      color,
      score,
      visibleCount,
      rationale
    };
  }).sort((left, right) => right.score - left.score);
};

const estimateClaimPaymentOpportunityCost = (
  board: BoardDefinition,
  gameState: GameState,
  action: ClaimRouteAction,
  route: RouteDefinition,
  colorDemand: Map<TrainColor, number>
): { penalty: number; rationale?: string } => {
  const color = action.payment.primaryColor;
  const cardsSpent = action.payment.colorCards;
  const unmetBefore = getNeededColorWeight(color, colorDemand, gameState.ourState.hand);
  const handAfterSpend = {
    ...gameState.ourState.hand,
    [color]: Math.max(0, gameState.ourState.hand[color] - cardsSpent)
  };
  const unmetAfter = getNeededColorWeight(color, colorDemand, handAfterSpend);
  const ownDemandPenalty = Math.max(0, unmetAfter - unmetBefore) * 1.35;

  let grayRouteAlternativePenalty = 0;
  let grayRouteReason: string | undefined;
  if (route.color === "gray") {
    const candidatePenalties = NON_LOCOMOTIVE_COLORS.filter(
      (candidateColor) =>
        (gameState.ourState.hand[candidateColor] ?? 0) >= cardsSpent && candidateColor !== color
    ).map((candidateColor) => {
      const candidateAfterSpend = {
        ...gameState.ourState.hand,
        [candidateColor]: Math.max(0, gameState.ourState.hand[candidateColor] - cardsSpent)
      };
      const before = getNeededColorWeight(candidateColor, colorDemand, gameState.ourState.hand);
      const after = getNeededColorWeight(candidateColor, colorDemand, candidateAfterSpend);
      return {
        color: candidateColor,
        penalty: Math.max(0, after - before)
      };
    });

    const bestAlternative = candidatePenalties.sort((left, right) => left.penalty - right.penalty)[0];
    if (bestAlternative && bestAlternative.penalty + 0.5 < Math.max(0, unmetAfter - unmetBefore)) {
      grayRouteAlternativePenalty =
        (Math.max(0, unmetAfter - unmetBefore) - bestAlternative.penalty) * 1.6;
      grayRouteReason = `spends ${color} on a gray route even though ${bestAlternative.color} was a cleaner payment color`;
    }
  }

  const sameColorLongerClaimPenalty = (() => {
    const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);
    const legalClaims = getLegalClaimRouteActions(gameState, board.routes, routesByParallelGroup);
    const currentRoutePoints = route.points;
    const betterSameColorClaim = legalClaims
      .filter(
        (candidate) =>
          candidate.payment.primaryColor === color &&
          candidate.routeId !== action.routeId
      )
      .map((candidate) => {
        const candidateRoute = board.routes.find((entry) => entry.id === candidate.routeId);
        return candidateRoute
          ? {
              routeId: candidate.routeId,
              length: candidateRoute.length,
              points: candidateRoute.points
            }
          : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => right.points - left.points)[0];

    if (
      betterSameColorClaim &&
      betterSameColorClaim.points >= currentRoutePoints + 4 &&
      betterSameColorClaim.length >= route.length + 2
    ) {
      return {
        penalty: 3.1,
        rationale: `uses ${color} on ${route.id} even though a higher-value ${betterSameColorClaim.length}-train ${color} claim is already available`
      };
    }

    return { penalty: 0 };
  })();

  const rationale = grayRouteReason ?? sameColorLongerClaimPenalty.rationale;
  return rationale
    ? {
        penalty:
          ownDemandPenalty + grayRouteAlternativePenalty + sameColorLongerClaimPenalty.penalty,
        rationale
      }
    : {
        penalty:
          ownDemandPenalty + grayRouteAlternativePenalty + sameColorLongerClaimPenalty.penalty
      };
};

const getTopTicketImprovementReasons = (
  board: BoardDefinition,
  currentStates: TicketProgressState[],
  nextStates: TicketProgressState[]
): string[] => {
  const nextByTicketId = new Map(
    nextStates.map((ticketState) => [ticketState.ticket.id, ticketState])
  );

  return currentStates
    .map((currentState) => {
      const nextState = nextByTicketId.get(currentState.ticket.id);

      if (!nextState) {
        return undefined;
      }

      const currentDistance =
        currentState.distance === Number.POSITIVE_INFINITY ? 20 : currentState.distance;
      const nextDistance =
        nextState.distance === Number.POSITIVE_INFINITY ? 20 : nextState.distance;
      const delta = currentDistance - nextDistance;

      return {
        label: formatTicketLabel(board, currentState.ticket),
        delta,
        completedNow: !currentState.completed && nextState.completed
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter((entry) => entry.delta > 0 || entry.completedNow)
    .sort((left, right) => {
      if (left.completedNow !== right.completedNow) {
        return Number(right.completedNow) - Number(left.completedNow);
      }

      return right.delta - left.delta;
    })
    .slice(0, 2)
    .map((entry) =>
      entry.completedNow
        ? `directly completes ${entry.label}`
        : `improves ${entry.label} by ${entry.delta} train${entry.delta > 1 ? "s" : ""}`
    );
};

const getTicketsNeedingColor = (
  board: BoardDefinition,
  gameState: GameState,
  color: TrainColor
): string[] => {
  if (color === "locomotive") {
    return getTicketProgressStates(board, gameState)
      .filter((ticketState) => !ticketState.completed)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 2)
      .map((ticketState) => formatTicketLabel(board, ticketState.ticket));
  }

  return getTicketProgressStates(board, gameState)
    .filter(
      (ticketState) =>
        !ticketState.completed &&
        ticketState.path.some((step) => step.color === color || step.color === "gray")
    )
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 2)
    .map((ticketState) => formatTicketLabel(board, ticketState.ticket));
};

const countNearReadyClaims = (
  board: BoardDefinition,
  gameState: GameState,
  color: TrainColor
): number => {
  const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);

  return board.routes.filter((route) => {
    if (gameState.publicState.claimedRoutes[route.id]) {
      return false;
    }

    const candidateHand = {
      ...gameState.ourState.hand,
      [color]: gameState.ourState.hand[color] + 1
    };

    return getLegalClaimRouteActions(
      {
        ...gameState,
        ourState: {
          ...gameState.ourState,
          hand: candidateHand
        }
      },
      [route],
      routesByParallelGroup
    ).length > 0;
  }).length;
};

interface BlindDrawOutcomeEstimate {
  color: TrainColor;
  probability: number;
}

interface TicketOfferEstimate {
  expectedKeepValue: number;
  bestOfferLabels: string[];
}

export interface BlindDrawColorInsight {
  color: TrainColor;
  probability: number;
  usefulness: number;
  usefulTickets: string[];
}

export interface BlindDrawInsight {
  locomotiveProbability: number;
  topUsefulColors: BlindDrawColorInsight[];
  topRawProbabilities: BlindDrawColorInsight[];
}

const getEstimatedBlindDrawDistribution = (
  gameState: GameState,
  maxOutcomes = BLIND_DRAW_OUTCOME_LIMIT
): BlindDrawOutcomeEstimate[] => {
  const remainingCounts = new Map<TrainColor, number>(
    Object.entries(TRAIN_DECK_COUNTS) as Array<[TrainColor, number]>
  );

  for (const color of gameState.publicState.faceUpCards) {
    remainingCounts.set(color, Math.max(0, (remainingCounts.get(color) ?? 0) - 1));
  }

  for (const color of Object.keys(gameState.ourState.hand) as TrainColor[]) {
    remainingCounts.set(
      color,
      Math.max(0, (remainingCounts.get(color) ?? 0) - (gameState.ourState.hand[color] ?? 0))
    );
  }

  for (const belief of gameState.beliefs) {
    for (const color of Object.keys(belief.handColorLowerBounds) as TrainColor[]) {
      remainingCounts.set(
        color,
        Math.max(
          0,
          (remainingCounts.get(color) ?? 0) - (belief.handColorLowerBounds[color] ?? 0)
        )
      );
    }
  }

  for (const color of Object.keys(gameState.annotations.knownOutOfDeckCounts ?? {}) as TrainColor[]) {
    remainingCounts.set(
      color,
      Math.max(
        0,
        (remainingCounts.get(color) ?? 0) -
          (gameState.annotations.knownOutOfDeckCounts?.[color] ?? 0)
      )
    );
  }

  const sortedOutcomes = [...remainingCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxOutcomes);

  const total = sortedOutcomes.reduce((sum, [, count]) => sum + count, 0);

  if (total <= 0 || sortedOutcomes.length === 0) {
    const fallback = [...TRAIN_COLORS].map((color) => ({
      color,
      probability: 1 / TRAIN_COLORS.length
    }));
    return fallback;
  }

  return sortedOutcomes.map(([color, count]) => ({
    color,
    probability: count / total
  }));
};

const getImmediateUrgentClaimPressure = (
  board: BoardDefinition,
  gameState: GameState
): {
  penalty: number;
  topUrgentRouteId?: RouteId;
} => {
  const bestClaim = getBestClaimRecommendation(board, gameState);
  const topUrgentRoute = getRouteUrgency(board, gameState)[0];
  const claimAction = bestClaim?.action;

  if (!bestClaim || !claimAction || claimAction.kind !== "claim-route" || !topUrgentRoute) {
    return { penalty: 0 };
  }

  const route = board.routes.find((candidate) => candidate.id === claimAction.routeId);
  if (!route) {
    return { penalty: 0 };
  }

  const claimNowSignal =
    bestClaim.utilityScore * 0.08 +
    topUrgentRoute.loseBeforeNextTurnProbability * 7 +
    (route.length >= 5 ? 1.8 : 0);

  return {
    penalty: claimNowSignal,
    topUrgentRouteId: route.id
  };
};

const estimateExpectedTicketOfferValue = (
  board: BoardDefinition,
  gameState: GameState
): TicketOfferEstimate => {
  const remainingCandidates = getUnknownTickets(board, gameState)
    .map((ticket) => ({
      ticket,
      value: estimateTicketStandaloneValue(board, gameState, ticket)
    }))
    .sort((left, right) => right.value - left.value);

  if (remainingCandidates.length === 0) {
    return {
      expectedKeepValue: 0,
      bestOfferLabels: []
    };
  }

  const topTickets = remainingCandidates.slice(0, 6);
  const syntheticOffers: Array<typeof topTickets> = [];

  for (let index = 0; index < topTickets.length; index += 1) {
    const first = topTickets[index];
    const second = topTickets[index + 1];
    const third = topTickets[index + 2];

    if (first && second && third) {
      syntheticOffers.push([first, second, third]);
    }
  }

  if (syntheticOffers.length === 0) {
    const fallbackOffer = remainingCandidates.slice(0, 3);
    const fallbackKeepValue = fallbackOffer
      .slice(0, 2)
      .reduce((sum, entry) => sum + entry.value, 0);

    return {
      expectedKeepValue: fallbackKeepValue,
      bestOfferLabels: fallbackOffer.slice(0, 2).map((entry) => formatTicketLabel(board, entry.ticket))
    };
  }

  const expectedKeepValue =
    syntheticOffers.reduce((sum, offer) => {
      const keepValue = offer
        .slice()
        .sort((left, right) => right.value - left.value)
        .slice(0, 2)
        .reduce((offerSum, entry) => offerSum + entry.value, 0);
      return sum + keepValue;
    }, 0) / syntheticOffers.length;

  const bestOfferLabels = syntheticOffers[0]
    ?.slice()
    .sort((left, right) => right.value - left.value)
    .slice(0, 2)
    .map((entry) => formatTicketLabel(board, entry.ticket)) ?? [];

  return {
    expectedKeepValue,
    bestOfferLabels
  };
};

const estimatePositionWinChanceProxy = (
  board: BoardDefinition,
  gameState: GameState
): number => {
  const publicPlayer = getPlayerPublicState(gameState);
  const ticketStates = getTicketProgressStates(board, gameState);
  const ticketExpectedValue = ticketStates.reduce(
    (sum, ticketState) =>
      sum +
      ticketState.ticket.points *
        (ticketState.completed
          ? 1
          : ticketState.distance === Number.POSITIVE_INFINITY
            ? 0.08
            : Math.max(0.12, 1 - ticketState.distance / 20)),
    0
  );
  const longestRoute = getLongestRouteForState(board, gameState);
  const trainsPressure =
    gameState.ourState.trainsRemaining >= 18
      ? 1.5
      : gameState.ourState.trainsRemaining >= 10
        ? 0.7
        : -1.2;
  const opponentTopScore = Math.max(
    0,
    ...gameState.publicState.players
      .filter((player) => player.playerId !== gameState.ourState.playerId)
      .map((player) => player.score)
  );
  const scoreLead = publicPlayer.score - opponentTopScore;

  return (
    publicPlayer.score * 0.28 +
    ticketExpectedValue * 0.52 +
    longestRoute * 0.34 +
    scoreLead * 0.16 +
    trainsPressure
  );
};

const estimateExpectedPositionWinChanceAfterActions = (
  board: BoardDefinition,
  gameState: GameState,
  actions: GameAction[]
): number => {
  let branches: WeightedHandState[] = [{ state: gameState, weight: 1 }];

  for (const action of actions) {
    branches = branches.flatMap((branch) =>
      applyApproximateActionBranches(board, branch, action)
    );
  }

  return branches.reduce(
    (sum, branch) => sum + estimatePositionWinChanceProxy(board, branch.state) * branch.weight,
    0
  );
};

const estimateExpectedClaimUtilityAfterLimitedRollout = (
  gameState: GameState,
  board: BoardDefinition,
  actions: GameAction[]
): number => {
  let branches: WeightedHandState[] = [{ state: gameState, weight: 1 }];

  for (const action of actions) {
    branches = branches.flatMap((branch) =>
      applyApproximateActionBranches(board, branch, action)
    );
  }

  return branches.reduce((sum, branch) => {
    const nextActionEvaluation = recommendActions(branch.state, board);
    const topImmediate = nextActionEvaluation.topRecommendation?.utilityScore ?? 0;
    const bestClaim = getBestClaimRecommendation(board, branch.state)?.utilityScore ?? 0;
    return sum + Math.max(topImmediate * 0.7, bestClaim) * branch.weight;
  }, 0);
};

export const getBlindDrawInsight = (
  gameState: GameState,
  board: BoardDefinition
): BlindDrawInsight => {
  const colorDemand = evaluateTickets(board, gameState).pathDemand;
  const outcomes = getEstimatedBlindDrawDistribution(gameState, TRAIN_COLORS.length);

  const perColor = outcomes.map((outcome) => {
    const nextState = withAdditionalCards(gameState, [outcome.color]);
    const nextClaim = getBestClaimRecommendation(board, nextState);
    const helpedTickets = getTicketsNeedingColor(board, gameState, outcome.color);
    const usefulness =
      (nextClaim?.utilityScore ?? 0) * 0.18 +
      getNeededColorWeight(outcome.color, colorDemand, gameState.ourState.hand) * 1.1 +
      countNearReadyClaims(board, gameState, outcome.color) * 0.8;

    return {
      color: outcome.color,
      probability: outcome.probability,
      usefulness,
      usefulTickets: helpedTickets
    };
  });

  return {
    locomotiveProbability:
      perColor.find((entry) => entry.color === "locomotive")?.probability ?? 0,
    topUsefulColors: [...perColor]
      .sort((left, right) => right.usefulness - left.usefulness)
      .slice(0, 3),
    topRawProbabilities: [...perColor]
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 3)
  };
};

const getBestClaimRecommendation = (
  board: BoardDefinition,
  gameState: GameState
): ActionRecommendation | undefined => {
  const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);
  const legalClaimActions = getLegalClaimRouteActions(
    gameState,
    board.routes,
    routesByParallelGroup
  );

  if (legalClaimActions.length === 0) {
    return undefined;
  }

  const routeUrgency = getRouteUrgency(board, gameState);
  return keepBestClaimRecommendationPerRoute(
    legalClaimActions.map((action) => scoreClaimAction(board, gameState, action, routeUrgency))
  )
    .sort((left, right) => right.utilityScore - left.utilityScore)[0];
};

const estimateExpectedNextClaimValue = (
  board: BoardDefinition,
  gameState: GameState
): {
  expectedUtility: number;
  expectedNearReadyClaims: number;
  topOutcomes: BlindDrawOutcomeEstimate[];
} => {
  const outcomes = getEstimatedBlindDrawDistribution(gameState);

  const expectedUtility = outcomes.reduce((sum, outcome) => {
    const nextState = withAdditionalCards(gameState, [outcome.color]);
    const nextClaim = getBestClaimRecommendation(board, nextState);
    return sum + (nextClaim?.utilityScore ?? 0) * outcome.probability;
  }, 0);

  const expectedNearReadyClaims = outcomes.reduce(
    (sum, outcome) =>
      sum + countNearReadyClaims(board, gameState, outcome.color) * outcome.probability,
    0
  );

  return {
    expectedUtility,
    expectedNearReadyClaims,
    topOutcomes: outcomes.slice(0, 2)
  };
};

const buildActionId = (action: GameAction): string => {
  switch (action.kind) {
    case "claim-route":
      return `${action.kind}:${action.routeId}:${action.payment.primaryColor}:${action.payment.colorCards}-${action.payment.locomotives}`;
    case "draw-face-up":
      return `${action.kind}:${action.color}:${action.drawIndex}`;
    case "draw-blind":
      return `${action.kind}:${action.drawIndex}`;
    case "draw-tickets":
      return `${action.kind}:${action.playerId}`;
    case "keep-tickets":
      return `${action.kind}:${action.keptTicketIds.join("|")}`;
    case "refresh-face-up":
      return `${action.kind}:${action.faceUpCards.join("|")}`;
  }
};

const buildTurnId = (actions: GameAction[]): string =>
  actions.map((action) => buildActionId(action)).join(" -> ");

const scoreClaimAction = (
  board: BoardDefinition,
  gameState: GameState,
  action: ClaimRouteAction,
  routeUrgency: RouteUrgencyEstimate[]
): ActionRecommendation => {
  const route = board.routes.find((candidate) => candidate.id === action.routeId);

  if (!route) {
    throw new Error(`Unknown route id: ${action.routeId}`);
  }

  const currentTicketStates = getTicketProgressStates(board, gameState);
  const currentGap = getCurrentTicketGap(board, gameState);
  const currentCompletedTickets = countCompletedTickets(board, gameState);
  const currentLongestRoute = getLongestRouteForState(board, gameState);
  const applied = applyOwnRouteClaim(gameState, route, action.payment).updatedState;
  const nextTicketStates = getTicketProgressStates(board, applied);
  const nextGap = getCurrentTicketGap(board, applied);
  const nextCompletedTickets = countCompletedTickets(board, applied);
  const nextLongestRoute = getLongestRouteForState(board, applied);
  const ticketProgressDelta = currentGap - nextGap;
  const completionDelta = nextCompletedTickets - currentCompletedTickets;
  const longestRouteDelta = nextLongestRoute - currentLongestRoute;
  const efficiency = route.points / route.length;
  const urgency =
    routeUrgency.find((estimate) => estimate.routeId === route.id)?.loseBeforeNextTurnProbability ??
    0;
  const endgameClock = estimateEndgameClock(gameState);
  const deploymentPressure = estimateDeploymentPressure(board, gameState);
  const nextRouteUrgency = getRouteUrgency(board, applied);
  const currentDetourExposure = estimateTicketDetourExposure(board, gameState, routeUrgency);
  const nextDetourExposure = estimateTicketDetourExposure(board, applied, nextRouteUrgency);
  const detourPenaltyImprovement = currentDetourExposure - nextDetourExposure;
  const colorDemand = evaluateTickets(board, gameState).pathDemand;
  const paymentOpportunity = estimateClaimPaymentOpportunityCost(
    board,
    gameState,
    action,
    route,
    colorDemand
  );
  const locomotiveSpendPenalty = action.payment.locomotives * 0.9;
  const trainsBefore = gameState.ourState.trainsRemaining;
  const trainsAfter = applied.ourState.trainsRemaining;
  const endgamePointPush =
    trainsBefore <= 8
      ? route.points * (0.18 + (8 - trainsBefore) * 0.07) +
        (route.length / Math.max(1, trainsBefore)) * 2.2
      : 0;
  const finishWindowBonus =
    trainsBefore <= 6
      ? route.points * 0.22 + route.length * 0.65
      : 0;
  const exactFinishBonus =
    trainsAfter === 0
      ? route.points * 0.55 + 5.5
      : trainsAfter <= 2
        ? route.points * 0.24 + 2.8
        : 0;
  const topTicketReasons = getTopTicketImprovementReasons(
    board,
    currentTicketStates,
    nextTicketStates
  );

  const featureBreakdown: EvaluationFeatures = {
    expectedFinalScore:
      getPlayerPublicState(applied).score +
      nextCompletedTickets * 3 +
      nextLongestRoute * 0.4,
    winProbabilityEstimate: Math.min(
      0.95,
      Math.max(
        0.05,
        0.45 + route.points * 0.01 + ticketProgressDelta * 0.015 + longestRouteDelta * 0.02
      )
    ),
    scoreDiffEstimate: route.points + completionDelta * 5 + longestRouteDelta * 0.8,
    routeValue:
      route.points +
      efficiency * 2.2 +
      urgency * 8 +
      endgamePointPush +
      (route.length >= 5 ? 1.8 : 0) -
      (route.length <= 3 && ticketProgressDelta <= 0 && urgency < 0.3 ? 2.2 : 0),
    ticketValue:
      ticketProgressDelta * 1.9 +
      completionDelta * 9 +
      detourPenaltyImprovement * 0.45,
    tempoValue:
      (route.length >= 5 ? 3.5 : route.length >= 3 ? 2 : 0.8) +
      deploymentPressure.claimBonus +
      endgameClock.immediateTriggerRisk * 2.2 +
      (route.length >= Math.max(1, gameState.ourState.trainsRemaining - 2) ? 2.8 : 0) +
      finishWindowBonus +
      exactFinishBonus,
    flexibilityValue: Math.max(0, 5 - action.payment.locomotives * 1.2),
    riskCost:
      locomotiveSpendPenalty +
      Math.max(0, -ticketProgressDelta * 0.3) +
      paymentOpportunity.penalty,
    blockExposure: urgency * 5,
    trainsRemainingPressure:
      gameState.ourState.trainsRemaining <= 12 ? route.length * 0.9 : route.length * 0.2,
    opponentClockPressure: estimateActionClockPressureImpact(
      endgameClock,
      "claim-route",
      route.length
    ),
    bottleneckUrgency:
      urgency * (route.length >= 5 ? 6.5 : 4.2) +
      (gameState.annotations.bottleneckRouteIds.includes(route.id) ? 2.8 : 0),
    ticketDetourPenalty: detourPenaltyImprovement
  };

  const utilityScore =
    featureBreakdown.routeValue +
    featureBreakdown.ticketValue +
    featureBreakdown.tempoValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.blockExposure +
    featureBreakdown.trainsRemainingPressure +
    featureBreakdown.opponentClockPressure * 0.45 +
    featureBreakdown.bottleneckUrgency * 0.6 +
    featureBreakdown.ticketDetourPenalty * 0.38 -
    featureBreakdown.riskCost;

  const rationale = [
    `scores ${route.points} immediate points on a length-${route.length} route`,
    ...topTicketReasons,
    ticketProgressDelta > 0 && topTicketReasons.length === 0
      ? `reduces total ticket gap by ${ticketProgressDelta}`
      : topTicketReasons.length === 0
        ? "does not directly advance current ticket shortest paths"
        : `reduces total ticket gap by ${ticketProgressDelta}`,
    completionDelta > 0
      ? `completes ${completionDelta} destination ticket${completionDelta > 1 ? "s" : ""}`
      : "does not complete a destination immediately",
    longestRouteDelta > 0
      ? `extends longest-route potential by ${longestRouteDelta}`
      : "has limited immediate longest-route gain",
    trainsBefore <= 8
      ? `late-game scoring pressure favors turning ${route.length} trains into ${route.points} points now`
      : "still leaves enough trains that exact endgame conversion is less urgent",
    trainsAfter <= 2
      ? "leaves very few trains, so immediate point conversion matters a lot here"
      : "does not immediately force a final-turn scoring squeeze",
    urgency > 0.35
      ? "secures a route that looks time-sensitive"
      : "route urgency is moderate",
    ...(paymentOpportunity.rationale ? [paymentOpportunity.rationale] : []),
    ...deploymentPressure.signals.map((signal) => `claim helps because ${signal}`),
    endgameClock.immediateTriggerRisk > 0.4
      ? "tempo matters because an opponent may be close to ending the game"
      : "endgame trigger risk is not immediate"
  ];

  return {
    action,
    actionId: buildActionId(action),
    utilityScore,
    confidence: Math.min(0.92, 0.5 + ticketProgressDelta * 0.03 + completionDelta * 0.12),
    rationale,
    featureBreakdown
  };
};

const estimateTicketStandaloneValue = (
  board: BoardDefinition,
  gameState: GameState,
  ticket: TicketDefinition
): number => {
  const pathEvaluation = evaluateTicketPath(
    board,
    gameState.publicState,
    gameState.ourState.playerId,
    ticket
  );

  if (pathEvaluation.distance === 0) {
    return ticket.points + 6;
  }

  if (pathEvaluation.distance === Number.POSITIVE_INFINITY) {
    return ticket.points * 0.15;
  }

  return ticket.points - pathEvaluation.distance * 0.65;
};

const scoreDrawTicketsAction = (
  board: BoardDefinition,
  gameState: GameState,
  action: DrawTicketsAction
): ActionRecommendation => {
  const currentTickets = getOurTickets(board, gameState);
  const completedTickets = countCompletedTickets(board, gameState);
  const ticketOfferEstimate = estimateExpectedTicketOfferValue(board, gameState);
  const expectedTicketGain = ticketOfferEstimate.expectedKeepValue;
  const safeToDrawFactor =
    gameState.ourState.trainsRemaining >= 18
      ? 1
      : gameState.ourState.trainsRemaining >= 12
        ? 0.55
        : 0.15;
  const completionRatio =
    currentTickets.length > 0 ? completedTickets / currentTickets.length : 1;
  const urgentClaimPressure = getImmediateUrgentClaimPressure(board, gameState);
  const endgameClock = estimateEndgameClock(gameState);
  const currentRouteUrgency = getRouteUrgency(board, gameState);
  const deploymentPressure = estimateDeploymentPressure(board, gameState);
  const currentDetourExposure = estimateTicketDetourExposure(
    board,
    gameState,
    currentRouteUrgency
  );
  const currentWinProxy = estimatePositionWinChanceProxy(board, gameState);
  const speculativeState = {
    ...gameState,
    ourState: {
      ...gameState.ourState,
      ticketIds: [
        ...gameState.ourState.ticketIds,
        ...getUnknownTickets(board, gameState)
          .slice(0, 2)
          .map((ticket) => ticket.id)
      ]
    }
  };
  const ticketDrawWinProxyDelta =
    estimatePositionWinChanceProxy(board, speculativeState) - currentWinProxy;
  const featureBreakdown: EvaluationFeatures = {
    ...createBlankFeatures(),
    expectedFinalScore: getPlayerPublicState(gameState).score + expectedTicketGain * 0.6,
    winProbabilityEstimate: Math.min(
      0.82,
      0.22 +
        expectedTicketGain * 0.015 +
        safeToDrawFactor * 0.18 +
        completionRatio * 0.08 -
        urgentClaimPressure.penalty * 0.004 +
        ticketDrawWinProxyDelta * 0.004 -
        endgameClock.nearTermTriggerRisk * 0.12
    ),
    scoreDiffEstimate: expectedTicketGain * 0.45 - urgentClaimPressure.penalty * 0.35,
    routeValue: 0.3,
    ticketValue: expectedTicketGain * safeToDrawFactor,
    tempoValue: safeToDrawFactor > 0.5 ? 1.6 : 0.4,
    flexibilityValue: 2.1 + safeToDrawFactor * 1.4,
    riskCost:
      (1 - safeToDrawFactor) * 5.5 +
      urgentClaimPressure.penalty * 0.8 +
      endgameClock.immediateTriggerRisk * 4.5,
    blockExposure: 0.4,
    trainsRemainingPressure:
      (safeToDrawFactor > 0.5 ? 0.5 : -2.4) -
      urgentClaimPressure.penalty * 0.22 -
      endgameClock.nearTermTriggerRisk * 1.8,
    opponentClockPressure: estimateActionClockPressureImpact(endgameClock, "draw-tickets"),
    bottleneckUrgency: -urgentClaimPressure.penalty * 0.55,
    ticketDetourPenalty: -currentDetourExposure * 0.3
  };

  const utilityScore =
    featureBreakdown.ticketValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.tempoValue +
    featureBreakdown.opponentClockPressure * 0.45 +
    featureBreakdown.bottleneckUrgency * 0.6 +
    featureBreakdown.ticketDetourPenalty * 0.38 -
    featureBreakdown.riskCost;

  return {
    action,
    actionId: buildActionId(action),
    utilityScore,
    confidence: Math.min(0.78, 0.3 + safeToDrawFactor * 0.3 + completionRatio * 0.15),
    rationale: [
      completionRatio >= 0.75
        ? "current ticket slate is mostly stabilized, so adding upside is reasonable"
        : "draws fresh tickets before current routes fully lock in",
      safeToDrawFactor > 0.5
        ? "there are still enough trains left to absorb an extra objective"
        : "late timing makes extra tickets risky",
      ...ticketOfferEstimate.bestOfferLabels.map(
        (label) => `strong candidate in likely offers: ${label}`
      ),
      urgentClaimPressure.topUrgentRouteId
        ? `delays an urgent route claim on ${urgentClaimPressure.topUrgentRouteId}`
        : "does not appear to delay a uniquely urgent route claim",
      endgameClock.signals[0] ?? "no opponent looks close to forcing the endgame",
      ticketDrawWinProxyDelta > 0
        ? `projected win-position proxy improves by ${ticketDrawWinProxyDelta.toFixed(1)}`
        : "extra tickets do not materially improve the current win-position proxy",
      `best remaining ticket upside estimate is ${expectedTicketGain.toFixed(1)}`
    ],
    featureBreakdown
  };
};

const scoreDrawFaceUpAction = (
  board: BoardDefinition,
  gameState: GameState,
  action: DrawFaceUpAction,
  colorDemand: Map<TrainColor, number>
): ActionRecommendation => {
  const nextState = withAdditionalCards(gameState, [action.color]);
  const nextClaimRecommendation = getBestClaimRecommendation(board, nextState);
  const urgentClaimPressure = getImmediateUrgentClaimPressure(board, gameState);
  const neededWeight = getNeededColorWeight(
    action.color,
    colorDemand,
    gameState.ourState.hand
  );
  const nearReadyClaims = countNearReadyClaims(board, gameState, action.color);
  const isLocomotive = action.color === "locomotive";
  const endgameClock = estimateEndgameClock(gameState);
  const currentRouteUrgency = getRouteUrgency(board, gameState);
  const deploymentPressure = estimateDeploymentPressure(board, gameState);
  const currentDetourExposure = estimateTicketDetourExposure(
    board,
    gameState,
    currentRouteUrgency
  );
  const helpedTickets = getTicketsNeedingColor(board, gameState, action.color);
  const knownHandSize = getKnownHandSize(gameState);
  const publicPlayer = getPlayerPublicState(gameState);
  const drawTactic = getDrawTacticProfile(
    colorDemand,
    gameState.ourState.hand,
    publicPlayer.claimedRouteIds.length
  );
  const currentTurnFirstDrawColor = gameState.annotations.currentTurnDrawColors?.[0];
  const currentTurnFirstDrawSource = gameState.annotations.currentTurnDrawSources?.[0];
  const isPriorityColor = drawTactic.priorityColors.has(action.color);
  const trainsRemaining = publicPlayer.trainsRemaining;
  const cardOverhang = Math.max(0, knownHandSize - trainsRemaining);
  const followUpClaimLabel =
    nextClaimRecommendation?.action.kind === "claim-route"
      ? nextClaimRecommendation.action.routeId
      : undefined;
  const winProxyDelta =
    estimatePositionWinChanceProxy(board, nextState) -
    estimatePositionWinChanceProxy(board, gameState);
  const openingFaceUpTax =
    !isLocomotive &&
    publicPlayer.claimedRouteIds.length === 0 &&
    knownHandSize < 20 &&
    nearReadyClaims === 0 &&
    drawTactic.mode === "value" &&
    !isPriorityColor &&
    neededWeight < 2.4 &&
    helpedTickets.length <= 1
      ? 3.6
      : !isLocomotive &&
          publicPlayer.claimedRouteIds.length === 0 &&
          drawTactic.mode === "value" &&
          knownHandSize < 18 &&
          nearReadyClaims === 0
        ? 1.8
        : 0;
  const earlyLocomotiveTax =
    isLocomotive &&
    publicPlayer.claimedRouteIds.length === 0 &&
    knownHandSize < 22 &&
    nearReadyClaims === 0 &&
    helpedTickets.length <= 1
      ? drawTactic.mode === "value"
        ? 17.8
        : 14.2
      : isLocomotive &&
          publicPlayer.claimedRouteIds.length <= 1 &&
          knownHandSize < 26 &&
          nearReadyClaims === 0
        ? drawTactic.mode === "value"
          ? 10.4
          : 7.6
        : 0;
  const lateLocomotiveTax =
    isLocomotive &&
    trainsRemaining <= 8 &&
    (knownHandSize >= trainsRemaining - 1 || gameState.ourState.hand.locomotive >= 2)
      ? 9.4 + Math.max(0, 8 - trainsRemaining) * 1.1
      : 0;
  const nonPriorityVisibleTax =
    !isLocomotive &&
    !isPriorityColor &&
    drawTactic.mode === "focus"
      ? neededWeight <= 0.5
        ? 5.4
        : 3.2
      : !isLocomotive &&
          !isPriorityColor &&
          drawTactic.mode === "value" &&
          knownHandSize > Math.min(22, trainsRemaining - 1)
        ? 2.1
        : 0;
  const followThroughVisibleBonus =
    gameState.publicState.phase === "drawing-cards" &&
    currentTurnFirstDrawSource === "face-up" &&
    currentTurnFirstDrawColor === action.color
      ? 7.6
      : gameState.publicState.phase === "drawing-cards" &&
          currentTurnFirstDrawSource === "face-up" &&
          isPriorityColor
        ? 3.4
        : 0;
  const featureBreakdown: EvaluationFeatures = {
    ...createBlankFeatures(),
    expectedFinalScore:
      getPlayerPublicState(gameState).score +
      neededWeight * 0.8 +
      (nextClaimRecommendation?.featureBreakdown.expectedFinalScore ?? 0) * 0.08,
    winProbabilityEstimate: Math.min(
      0.85,
      0.35 +
        neededWeight * 0.03 +
        nearReadyClaims * 0.015 +
        (isLocomotive ? 0.12 : 0) +
        (nextClaimRecommendation?.utilityScore ?? 0) * 0.002 +
        winProxyDelta * 0.01
    ),
    scoreDiffEstimate:
      neededWeight * 0.6 +
      nearReadyClaims * 0.5 +
      (nextClaimRecommendation?.utilityScore ?? 0) * 0.12,
    routeValue:
      nearReadyClaims * 0.8 +
      followThroughVisibleBonus * 0.26 +
      (nextClaimRecommendation?.utilityScore ?? 0) * 0.18,
    ticketValue:
      neededWeight * (isPriorityColor ? 1.7 : 1.25) + followThroughVisibleBonus,
    tempoValue: isLocomotive ? 2.6 : 1.1,
    flexibilityValue:
      isLocomotive
        ? 5.5
        : neededWeight * 0.7 + 1.5 + (isPriorityColor ? 0.55 : 0),
    riskCost:
      (isLocomotive ? 0.8 : 0.3) +
      openingFaceUpTax +
      earlyLocomotiveTax +
      lateLocomotiveTax +
      nonPriorityVisibleTax +
      cardOverhang * 1.45 +
      deploymentPressure.drawPenalty * (isLocomotive ? 0.72 : 0.88) +
      Math.max(0, urgentClaimPressure.penalty - (nextClaimRecommendation?.utilityScore ?? 0)) *
        0.12 +
      endgameClock.immediateTriggerRisk * 2.4,
    blockExposure: urgentClaimPressure.penalty * 0.08,
    trainsRemainingPressure: -endgameClock.nearTermTriggerRisk * 1.2,
    opponentClockPressure: estimateActionClockPressureImpact(endgameClock, "draw-face-up"),
    bottleneckUrgency: -urgentClaimPressure.penalty * (isLocomotive ? 0.22 : 0.3),
    ticketDetourPenalty: -currentDetourExposure * (isLocomotive ? 0.08 : 0.12)
  };

  const utilityScore =
    featureBreakdown.ticketValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.tempoValue +
    featureBreakdown.routeValue +
    featureBreakdown.opponentClockPressure * 0.45 +
    featureBreakdown.bottleneckUrgency * 0.6 +
    featureBreakdown.ticketDetourPenalty * 0.38 -
    featureBreakdown.riskCost;

  const rationale = [
    isLocomotive
      ? "takes a wildcard that stays live across many plans"
      : `adds ${action.color} toward currently shortest ticket paths`,
    ...helpedTickets.map((ticketLabel) => `supports ${ticketLabel}`),
    nearReadyClaims > 0
      ? `opens or strengthens ${nearReadyClaims} near-ready claim options`
      : "is mostly a setup draw rather than an immediate claim enabler",
    followUpClaimLabel
      ? `sets up a stronger follow-up claim on ${followUpClaimLabel}`
      : "does not unlock a clearly strong claim immediately",
    urgentClaimPressure.topUrgentRouteId && !followUpClaimLabel
      ? `still risks delaying ${urgentClaimPressure.topUrgentRouteId}`
      : "does not obviously lose tempo against the most urgent route",
    neededWeight > 0
      ? `matches current route-color demand weight ${neededWeight.toFixed(1)}`
      : "is not a top-demand color for current tickets",
    isPriorityColor
      ? `${action.color} is in the current priority-color set`
      : `${action.color} is not one of the current priority colors`,
    followThroughVisibleBonus > 0
      ? `continues the same turn's visible color focus on ${action.color}`
      : "does not receive any same-turn visible follow-through bonus",
    nonPriorityVisibleTax > 0
      ? "visible draw is taxed because this color does not fit the current route-focused plan"
      : "visible draw is not being punished for route-focus mismatch",
    openingFaceUpTax > 0
      ? "open face-up draw is taxed here because the position still prefers broader hidden setup"
      : "face-up draw is not especially taxed by the current opening posture",
    endgameClock.signals[0] ?? "endgame timing is not pressuring this draw yet",
    earlyLocomotiveTax > 0
      ? "face-up locomotive is taxed here because early flexibility is already good enough"
      : "face-up locomotive is not overly taxed in this position",
    lateLocomotiveTax > 0
      ? "face-up locomotive is strongly taxed because late-game extra flexibility is no longer converting cleanly into tempo"
      : "late-game locomotive tax is not strongly active here",
    cardOverhang > 0
      ? `draw is punished because the hand already exceeds remaining trains by ${cardOverhang}`
      : "hand size is not yet larger than the remaining train budget",
    ...deploymentPressure.signals.map((signal) => `draw is less attractive because ${signal}`),
    winProxyDelta > 0
      ? `improves short-horizon win proxy by ${winProxyDelta.toFixed(1)}`
      : "does not materially improve the immediate win proxy"
  ];

  return {
    action,
    actionId: buildActionId(action),
    utilityScore,
    confidence: Math.min(0.85, 0.42 + neededWeight * 0.04 + (isLocomotive ? 0.1 : 0)),
    rationale,
    featureBreakdown
  };
};

const scoreDrawBlindAction = (
  board: BoardDefinition,
  gameState: GameState,
  action: DrawBlindAction,
  colorDemand: Map<TrainColor, number>
): ActionRecommendation => {
  const totalDemand = [...colorDemand.values()].reduce((sum, value) => sum + value, 0);
  const blindExpectation = estimateExpectedNextClaimValue(board, gameState);
  const urgentClaimPressure = getImmediateUrgentClaimPressure(board, gameState);
  const endgameClock = estimateEndgameClock(gameState);
  const currentRouteUrgency = getRouteUrgency(board, gameState);
  const deploymentPressure = estimateDeploymentPressure(board, gameState);
  const currentDetourExposure = estimateTicketDetourExposure(
    board,
    gameState,
    currentRouteUrgency
  );
  const activeTicketLabels = getTicketProgressStates(board, gameState)
    .filter((ticketState) => !ticketState.completed)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 2)
    .map((ticketState) => formatTicketLabel(board, ticketState.ticket));
  const drawPilePressure =
    gameState.publicState.drawPileCount > 25 ? 1.8 : gameState.publicState.drawPileCount > 10 ? 1.2 : 0.6;
  const publicPlayer = getPlayerPublicState(gameState);
  const knownHandSize = getKnownHandSize(gameState);
  const trainsRemaining = publicPlayer.trainsRemaining;
  const cardOverhang = Math.max(0, knownHandSize - trainsRemaining);
  const drawTactic = getDrawTacticProfile(
    colorDemand,
    gameState.ourState.hand,
    publicPlayer.claimedRouteIds.length
  );
  const currentTurnFirstDrawColor = gameState.annotations.currentTurnDrawColors?.[0];
  const currentTurnFirstDrawSource = gameState.annotations.currentTurnDrawSources?.[0];
  const visiblePriorityColors = new Set(
    gameState.publicState.faceUpCards.filter((color) => drawTactic.priorityColors.has(color))
  );
  const openingBlindBonus =
    publicPlayer.claimedRouteIds.length === 0 &&
    knownHandSize < 20 &&
    deploymentPressure.readyLongClaimCount === 0
      ? knownHandSize < 16
        ? 3.2
        : 2.0
      : publicPlayer.claimedRouteIds.length <= 1 &&
          knownHandSize < 20 &&
          deploymentPressure.readyClaimCount === 0
        ? 1.2
        : 0;
  const tacticBlindBonus =
    drawTactic.mode === "value"
      ? 1.5 + Math.max(0, 0.92 - drawTactic.concentration)
      : drawTactic.mode === "focus" && drawTactic.topUnmet < 5
        ? 0.25
        : 0;
  const lateHandBlindTax =
    knownHandSize > Math.min(24, publicPlayer.trainsRemaining)
      ? (knownHandSize - Math.min(24, publicPlayer.trainsRemaining)) * 0.95
      : 0;
  const overhangBlindTax = cardOverhang * 2.35;
  const sameTurnVisibleFollowThroughTax =
    gameState.publicState.phase === "drawing-cards" &&
    currentTurnFirstDrawSource === "face-up" &&
    currentTurnFirstDrawColor &&
    gameState.publicState.faceUpCards.some((color) => color === currentTurnFirstDrawColor)
      ? 18
      : gameState.publicState.phase === "drawing-cards" &&
          currentTurnFirstDrawSource === "face-up" &&
          visiblePriorityColors.size > 0
        ? 12
        : 0;
  const expectedWinProxyAfterBlind = estimateExpectedPositionWinChanceAfterActions(
    board,
    gameState,
    [action]
  );
  const currentWinProxy = estimatePositionWinChanceProxy(board, gameState);
  const winProxyDelta = expectedWinProxyAfterBlind - currentWinProxy;
  const featureBreakdown: EvaluationFeatures = {
    ...createBlankFeatures(),
    expectedFinalScore:
      getPlayerPublicState(gameState).score +
      totalDemand * 0.25 +
      blindExpectation.expectedUtility * 0.08,
    winProbabilityEstimate: Math.min(
      0.78,
        0.28 +
        totalDemand * 0.01 +
        drawPilePressure * 0.05 +
        blindExpectation.expectedUtility * 0.002 +
        winProxyDelta * 0.006 -
        endgameClock.nearTermTriggerRisk * 0.1
    ),
    scoreDiffEstimate: totalDemand * 0.15 + blindExpectation.expectedUtility * 0.12,
    routeValue:
      blindExpectation.expectedUtility * 0.16 +
      blindExpectation.expectedNearReadyClaims * 0.35,
    ticketValue: totalDemand * 0.35,
    tempoValue: 0.9 + openingBlindBonus * 0.35 + tacticBlindBonus * 0.18,
    flexibilityValue:
      2.2 +
      drawPilePressure +
      blindExpectation.expectedNearReadyClaims * 0.15 +
      openingBlindBonus +
      tacticBlindBonus,
    riskCost:
      0.2 +
      deploymentPressure.drawPenalty * 1.08 +
      lateHandBlindTax +
      overhangBlindTax +
      sameTurnVisibleFollowThroughTax +
      urgentClaimPressure.penalty * 0.32 +
      endgameClock.immediateTriggerRisk * 2.8,
    blockExposure: urgentClaimPressure.penalty * 0.12,
    trainsRemainingPressure:
      -urgentClaimPressure.penalty * 0.08 - endgameClock.nearTermTriggerRisk * 1.4,
    opponentClockPressure: estimateActionClockPressureImpact(endgameClock, "draw-blind"),
    bottleneckUrgency: -urgentClaimPressure.penalty * 0.42,
    ticketDetourPenalty: -currentDetourExposure * 0.18
  };

  const utilityScore =
    featureBreakdown.routeValue +
    featureBreakdown.ticketValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.tempoValue +
    featureBreakdown.opponentClockPressure * 0.45 +
    featureBreakdown.bottleneckUrgency * 0.6 +
    featureBreakdown.ticketDetourPenalty * 0.38 -
    featureBreakdown.riskCost;

  return {
    action,
    actionId: buildActionId(action),
    utilityScore,
    confidence: Math.min(
      0.58,
      0.28 + (blindExpectation.topOutcomes[0]?.probability ?? 0) * 0.25
    ),
    rationale: [
      "keeps color options open when no single face-up card dominates",
      ...activeTicketLabels.map((ticketLabel) => `stays live for ${ticketLabel}`),
      ...blindExpectation.topOutcomes.map(
        (outcome) =>
          `${outcome.color} is a relatively likely hidden hit (${Math.round(
            outcome.probability * 100
          )}%)`
      ),
      blindExpectation.expectedUtility > 0
        ? `expected hidden draw improves next-claim quality by ${blindExpectation.expectedUtility.toFixed(1)}`
        : "hidden draw looks more like flexibility than immediate power",
      openingBlindBonus > 0
        ? "opening posture gives extra value to a flexible blind draw here"
        : "blind draw is not receiving extra opening-phase credit here",
      lateHandBlindTax > 0
        ? "blind draw is taxed because the hand is already too large for the remaining deployment window"
        : "hand size does not yet strongly punish another blind draw",
      cardOverhang > 0
        ? `blind draw is heavily penalized because the hand already exceeds remaining trains by ${cardOverhang}`
        : "remaining trains still leave room for another flexible draw",
      sameTurnVisibleFollowThroughTax > 0
        ? "blind draw is strongly taxed because a visible priority follow-up is still available this turn"
        : "blind draw is not being punished by same-turn visible follow-through pressure",
      drawTactic.mode === "value"
        ? "current tactic still favors broad value accumulation over visible color commitment"
        : "current tactic is already focused enough that blind draw gets less extra credit",
      winProxyDelta > 0
        ? `expected blind draw improves short-horizon win proxy by ${winProxyDelta.toFixed(1)}`
        : "blind draw does not substantially improve the short-horizon win proxy",
      urgentClaimPressure.topUrgentRouteId
        ? `blind draw must justify delaying ${urgentClaimPressure.topUrgentRouteId}`
        : "no single urgent claim currently dominates the position",
      ...deploymentPressure.signals.map((signal) => `blind draw is less attractive because ${signal}`),
      endgameClock.signals[0] ?? "no opponent looks ready to compress the game clock",
      totalDemand > 0
        ? "still has decent expected value because multiple colors remain useful"
        : "acts as a low-commitment setup draw"
    ],
    featureBreakdown
  };
};

const keepBestClaimRecommendationPerRoute = (
  recommendations: ActionRecommendation[]
): ActionRecommendation[] => {
  const bestByRouteId = new Map<string, ActionRecommendation>();

  for (const recommendation of recommendations) {
    if (recommendation.action.kind !== "claim-route") {
      continue;
    }

    const existing = bestByRouteId.get(recommendation.action.routeId);

    if (!existing || recommendation.utilityScore > existing.utilityScore) {
      bestByRouteId.set(recommendation.action.routeId, recommendation);
    }
  }

  return [...bestByRouteId.values()];
};

const buildTicketKeepActions = (gameState: GameState): GameAction[] => {
  const pendingChoice = gameState.pendingTicketChoice;

  if (
    gameState.publicState.phase !== "resolving-ticket-keep" ||
    !pendingChoice ||
    pendingChoice.playerId !== gameState.ourState.playerId
  ) {
    return [];
  }

  const combinations: GameAction[] = [];
  const offered = pendingChoice.offeredTicketIds;
  const count = offered.length;

  for (let mask = 1; mask < 1 << count; mask += 1) {
    const keptTicketIds = offered.filter((_, index) => (mask & (1 << index)) !== 0);

    if (keptTicketIds.length < pendingChoice.minimumKeepCount) {
      continue;
    }

    combinations.push({
      kind: "keep-tickets",
      playerId: gameState.ourState.playerId,
      keptTicketIds,
      rejectedTicketIds: offered.filter((ticketId) => !keptTicketIds.includes(ticketId))
    });
  }

  return combinations;
};

const getLegalDrawActions = (gameState: GameState): Array<DrawFaceUpAction | DrawBlindAction> => {
  if (gameState.publicState.currentPlayerId !== gameState.ourState.playerId) {
    return [];
  }

  if (gameState.publicState.phase === "ready") {
    const faceUpActions = gameState.publicState.faceUpCards.map(
      (color): DrawFaceUpAction => ({
        kind: "draw-face-up",
        playerId: gameState.ourState.playerId,
        color,
        drawIndex: 1
      })
    );

    return [
      ...faceUpActions,
      {
        kind: "draw-blind",
        playerId: gameState.ourState.playerId,
        drawIndex: 1
      }
    ];
  }

  if (gameState.publicState.phase === "drawing-cards") {
    const faceUpActions = gameState.publicState.faceUpCards
      .filter((color) => color !== "locomotive")
      .map(
        (color): DrawFaceUpAction => ({
          kind: "draw-face-up",
          playerId: gameState.ourState.playerId,
          color,
          drawIndex: 2
        })
      );

    return [
      ...faceUpActions,
      {
        kind: "draw-blind",
        playerId: gameState.ourState.playerId,
        drawIndex: 2
      }
    ];
  }

  return [];
};

const getLegalTicketDrawActions = (
  gameState: GameState
): DrawTicketsAction[] => {
  if (
    gameState.publicState.currentPlayerId !== gameState.ourState.playerId ||
    gameState.publicState.phase !== "ready" ||
    gameState.pendingTicketChoice
  ) {
    return [];
  }

  return [
    {
      kind: "draw-tickets",
      playerId: gameState.ourState.playerId,
      offeredTicketIds: []
    }
  ];
};

export const recommendActions = (
  gameState: GameState,
  board: BoardDefinition
): PositionEvaluation => {
  if (
    gameState.publicState.phase === "resolving-ticket-keep" &&
    gameState.pendingTicketChoice?.playerId === gameState.ourState.playerId
  ) {
    const keepActions = buildTicketKeepActions(gameState);
    const alternatives = keepActions
      .map((action) => {
        if (action.kind !== "keep-tickets") {
          throw new Error("Unexpected non keep-tickets action in keep phase.");
        }

        const keptTickets = board.tickets.filter((ticket) =>
          action.keptTicketIds.includes(ticket.id)
        );
        const utilityScore = keptTickets.reduce(
          (sum, ticket) => sum + estimateTicketStandaloneValue(board, gameState, ticket),
          0
        );
        const minimumKeepCount = gameState.pendingTicketChoice?.minimumKeepCount ?? 1;
        const openingKeepPenalty =
          getPlayerPublicState(gameState).claimedRouteIds.length === 0
            ? Math.max(0, action.keptTicketIds.length - minimumKeepCount) * 4
            : 0;
        const riskCost =
          Math.max(0, action.keptTicketIds.length - 1) * 1.25 + openingKeepPenalty;
        const featureBreakdown: EvaluationFeatures = {
          ...createBlankFeatures(),
          expectedFinalScore: getPlayerPublicState(gameState).score + utilityScore * 0.7,
          winProbabilityEstimate: Math.min(0.8, 0.35 + utilityScore * 0.02 - riskCost * 0.03),
          scoreDiffEstimate: utilityScore * 0.4,
          routeValue: 0,
          ticketValue: utilityScore,
          tempoValue: 0.2,
          flexibilityValue: Math.max(0.5, 3 - riskCost),
          riskCost,
          blockExposure: 0,
          trainsRemainingPressure: -riskCost * 0.25,
          opponentClockPressure: 0,
          bottleneckUrgency: 0,
          ticketDetourPenalty: 0
        };

        return {
          action,
          actionId: buildActionId(action),
          utilityScore: utilityScore - riskCost,
          confidence: Math.min(0.84, 0.45 + keptTickets.length * 0.08),
          rationale: [
            `keeps ${keptTickets.length} ticket${keptTickets.length > 1 ? "s" : ""}`,
            openingKeepPenalty > 0
              ? "keeping extra tickets early adds real risk before a network exists"
              : "does not overextend ticket risk for the current stage",
            ...keptTickets
              .slice()
              .sort(
                (left, right) =>
                  estimateTicketStandaloneValue(board, gameState, right) -
                  estimateTicketStandaloneValue(board, gameState, left)
              )
              .slice(0, 2)
              .map(
                (ticket) =>
                  `${formatTicketLabel(board, ticket)} looks relatively efficient within the current ticket mix`
              )
          ],
          featureBreakdown
        } satisfies ActionRecommendation;
      })
      .sort((left, right) => right.utilityScore - left.utilityScore);

    return {
      ...(alternatives[0] ? { topRecommendation: alternatives[0] } : {}),
      alternatives,
      ticketEstimates: evaluateTickets(board, gameState).tickets,
      routeUrgency: []
    };
  }

  const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);
  const legalClaimActions = getLegalClaimRouteActions(
    gameState,
    board.routes,
    routesByParallelGroup
  );
  const legalDrawActions = getLegalDrawActions(gameState);
  const legalTicketDrawActions = getLegalTicketDrawActions(gameState);
  const ticketEvaluation = evaluateTickets(board, gameState);
  const routeUrgency = getRouteUrgency(board, gameState);
  const claimRecommendations = keepBestClaimRecommendationPerRoute(
    legalClaimActions.map((action) =>
      scoreClaimAction(board, gameState, action, routeUrgency)
    )
  );

  const alternatives: ActionRecommendation[] = [
    ...claimRecommendations,
    ...legalDrawActions.map((action) =>
      action.kind === "draw-face-up"
        ? scoreDrawFaceUpAction(board, gameState, action, ticketEvaluation.pathDemand)
        : scoreDrawBlindAction(board, gameState, action, ticketEvaluation.pathDemand)
    ),
    ...legalTicketDrawActions.map((action) => scoreDrawTicketsAction(board, gameState, action))
  ].sort((left, right) => right.utilityScore - left.utilityScore);

  return {
    ...(alternatives[0] ? { topRecommendation: alternatives[0] } : {}),
    alternatives,
    ticketEstimates: ticketEvaluation.tickets,
    routeUrgency
  };
};

const cloneHand = (hand: GameState["ourState"]["hand"]): GameState["ourState"]["hand"] => ({
  ...hand
});

const withAdditionalCards = (
  gameState: GameState,
  colors: TrainColor[]
): GameState => {
  const nextHand = cloneHand(gameState.ourState.hand);

  for (const color of colors) {
    nextHand[color] += 1;
  }

  return {
    ...gameState,
    ourState: {
      ...gameState.ourState,
      hand: nextHand
    }
  };
};

interface WeightedHandState {
  state: GameState;
  weight: number;
}

interface OpponentResponseRiskEstimate {
  expectedPenalty: number;
  threatenedRouteId?: RouteId;
  signals: string[];
}

interface EndgameClockEstimate {
  immediateTriggerRisk: number;
  nearTermTriggerRisk: number;
  selfTriggerChance: number;
  signals: string[];
}

const getExpectedColorCountForBelief = (
  belief: GameState["beliefs"][number],
  color: TrainColor
): number =>
  Math.max(
    belief.handColorExpectedCounts[color] ?? 0,
    belief.handColorLowerBounds[color] ?? 0
  );

const estimateBeliefColorAvailability = (
  gameState: GameState,
  belief: GameState["beliefs"][number],
  color: TrainColor
): number => {
  const publicPlayer = gameState.publicState.players.find(
    (player) => player.playerId === belief.playerId
  );
  const lowerBounds = belief.handColorLowerBounds;
  const knownTotal = Object.values(lowerBounds).reduce((sum, count) => sum + (count ?? 0), 0);
  const handCount = publicPlayer?.handCount ?? knownTotal;
  const unknownSlots = Math.max(0, handCount - knownTotal);
  const baselineUnknownShare =
    color === "locomotive" ? unknownSlots / 9 : unknownSlots / NON_LOCOMOTIVE_COLORS.length;

  return getExpectedColorCountForBelief(belief, color) + baselineUnknownShare;
};

const getOpponentClaimabilityForRoute = (
  gameState: GameState,
  route: RouteDefinition,
  belief: GameState["beliefs"][number]
): number => {
  const locomotiveSupport = estimateBeliefColorAvailability(gameState, belief, "locomotive");

  let available = 0;
  if (route.color === "gray") {
    available = Math.max(
      ...NON_LOCOMOTIVE_COLORS.map((color) =>
        estimateBeliefColorAvailability(gameState, belief, color)
      ),
      0
    );
  } else {
    available = estimateBeliefColorAvailability(gameState, belief, route.color);
  }

  const supplyRatio = Math.min(1, (available + locomotiveSupport) / route.length);
  const easyLengthBias =
    route.length <= 2 ? 0.2 : route.length <= 4 ? 0.12 : route.length === 5 ? 0.07 : 0.04;

  return Math.min(0.95, easyLengthBias + supplyRatio * 0.72);
};

const getOpponentPressureForRouteByBelief = (
  board: BoardDefinition,
  route: RouteDefinition,
  belief: GameState["beliefs"][number]
): {
  pressure: number;
  signals: string[];
} => {
  let pressure = 0;
  const signals: string[] = [];

  for (const familyRead of belief.ticketFamilyPosterior) {
    const relevance = getTicketFamilyRouteRelevance(board, route, familyRead.family);
    const contribution = familyRead.weight * relevance;

    if (contribution < 0.18) {
      continue;
    }

    pressure += contribution * 0.8;
    if (signals.length < 2) {
      signals.push(`${belief.playerId} likely on ${familyRead.family.replaceAll("-", " ")}`);
    }
  }

  for (const corridor of belief.corridorInterest) {
    const corridorMatches =
      corridor.corridorId === route.id ||
      corridor.corridorId === route.parallelGroup ||
      route.tags.includes(corridor.corridorId) ||
      route.cityA === corridor.corridorId ||
      route.cityB === corridor.corridorId;

    if (!corridorMatches || corridor.weight < 0.2) {
      continue;
    }

    pressure += corridor.weight;
    if (signals.length < 2) {
      signals.push(`${belief.playerId} interested in ${corridor.corridorId}`);
    }
  }

  return { pressure, signals };
};

const applyApproximateActionBranches = (
  board: BoardDefinition,
  branch: WeightedHandState,
  action: GameAction
): WeightedHandState[] => {
  if (action.kind === "draw-face-up") {
    return [
      {
        state: withAdditionalCards(branch.state, [action.color]),
        weight: branch.weight
      }
    ];
  }

  if (action.kind === "draw-blind") {
    return getEstimatedBlindDrawDistribution(branch.state).map((outcome) => ({
      state: withAdditionalCards(branch.state, [outcome.color]),
      weight: branch.weight * outcome.probability
    }));
  }

  if (action.kind === "claim-route") {
    const route = board.routes.find((candidate) => candidate.id === action.routeId);
    if (!route) {
      return [branch];
    }

    return [
      {
        state: applyOwnRouteClaim(branch.state, route, action.payment).updatedState,
        weight: branch.weight
      }
    ];
  }

  return [branch];
};

const estimateOpponentResponseRiskFromState = (
  board: BoardDefinition,
  gameState: GameState
): OpponentResponseRiskEstimate => {
  const effectiveGameState = {
    ...gameState,
    beliefs: getEffectiveBeliefs(board, gameState)
  };
  const urgentRoutes = getRouteUrgency(board, gameState).slice(0, 4);
  const routesById = indexRoutesById(board.routes);
  let bestPenalty = 0;
  let threatenedRouteId: RouteId | undefined;
  let bestSignals: string[] = [];

  for (const urgentRoute of urgentRoutes) {
    const route = routesById.get(urgentRoute.routeId);
    if (!route) {
      continue;
    }

    let bestThreat = 0;
    let bestThreatSignals: string[] = [];

    for (const belief of effectiveGameState.beliefs) {
      const claimability = getOpponentClaimabilityForRoute(effectiveGameState, route, belief);
      const pressure = getOpponentPressureForRouteByBelief(board, route, belief);
      const threat = claimability * (1 + pressure.pressure * 0.35);

      if (threat > bestThreat) {
        bestThreat = threat;
        bestThreatSignals = [
          ...pressure.signals,
          `claimability ${Math.round(claimability * 100)}%`
        ];
      }
    }

    const damage =
      urgentRoute.loseBeforeNextTurnProbability *
      bestThreat *
      (route.points * 0.75 + route.length * 1.4 + (route.length >= 5 ? 2.6 : 0.8));

    if (damage > bestPenalty) {
      bestPenalty = damage;
      threatenedRouteId = route.id;
      bestSignals = bestThreatSignals;
    }
  }

  return {
    expectedPenalty: bestPenalty,
    ...(threatenedRouteId ? { threatenedRouteId } : {}),
    signals: bestSignals
  };
};

const estimateEndgameClock = (
  gameState: GameState
): EndgameClockEstimate => {
  const signals: string[] = [];
  let immediateTriggerRisk = 0;
  let nearTermTriggerRisk = 0;
  let selfTriggerChance = 0;

  for (const player of gameState.publicState.players) {
    const neededForTrigger = Math.max(0, player.trainsRemaining - 2);
    const canTriggerInOneTurn =
      neededForTrigger > 0 &&
      neededForTrigger <= 6 &&
      player.handCount >= neededForTrigger;
    const oneTurnRisk = canTriggerInOneTurn
      ? Math.min(0.95, 0.28 + neededForTrigger * 0.08 + Math.min(6, player.handCount - neededForTrigger) * 0.03)
      : 0;
    const canTriggerInTwoTurns =
      neededForTrigger > 0 &&
      neededForTrigger <= 8 &&
      player.handCount + 2 >= neededForTrigger;
    const twoTurnRisk = canTriggerInTwoTurns
      ? Math.min(0.95, oneTurnRisk + 0.18 + Math.max(0, 8 - neededForTrigger) * 0.03)
      : oneTurnRisk;

    if (player.playerId === gameState.ourState.playerId) {
      selfTriggerChance = oneTurnRisk;
      continue;
    }

    if (oneTurnRisk > immediateTriggerRisk) {
      immediateTriggerRisk = oneTurnRisk;
      if (signals.length < 2) {
        signals.push(
          `${player.displayName} can plausibly trigger endgame with ${player.trainsRemaining} trains and ${player.handCount} cards`
        );
      }
    }

    nearTermTriggerRisk = Math.max(nearTermTriggerRisk, twoTurnRisk);
  }

  return {
    immediateTriggerRisk,
    nearTermTriggerRisk,
    selfTriggerChance,
    signals
  };
};

const estimateExpectedClaimUtilityAfterActions = (
  gameState: GameState,
  board: BoardDefinition,
  actions: GameAction[]
): number => {
  let branches: WeightedHandState[] = [{ state: gameState, weight: 1 }];

  for (const action of actions) {
    branches = branches.flatMap((branch) =>
      applyApproximateActionBranches(board, branch, action)
    );
  }

  return branches.reduce((sum, branch) => {
    const bestClaim = getBestClaimRecommendation(board, branch.state);
    return sum + (bestClaim?.utilityScore ?? 0) * branch.weight;
  }, 0);
};

const getBestFaceUpFollowUps = (
  gameState: GameState,
  firstDrawIndex?: number
): Array<DrawFaceUpAction | DrawBlindAction> => {
  const remainingFaceUp = gameState.publicState.faceUpCards.filter(
    (_, index) => index !== firstDrawIndex
  );
  const faceUpFollowUps = remainingFaceUp
    .filter((color) => color !== "locomotive")
    .map(
      (color): DrawFaceUpAction => ({
        kind: "draw-face-up",
        playerId: gameState.ourState.playerId,
        color,
        drawIndex: 2
      })
    );

  return [
    ...faceUpFollowUps,
    {
      kind: "draw-blind",
      playerId: gameState.ourState.playerId,
      drawIndex: 2
    }
  ];
};

const buildLegalTurnCandidates = (
  gameState: GameState,
  board: BoardDefinition
): GameAction[][] => {
  if (
    gameState.publicState.phase === "resolving-ticket-keep" &&
    gameState.pendingTicketChoice?.playerId === gameState.ourState.playerId
  ) {
    return buildTicketKeepActions(gameState).map((action) => [action]);
  }

  const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);
  const claimTurns = getLegalClaimRouteActions(
    gameState,
    board.routes,
    routesByParallelGroup
  ).map((action) => [action] satisfies GameAction[]);
  const drawTicketTurns = getLegalTicketDrawActions(gameState).map(
    (action) => [action] satisfies GameAction[]
  );

  const drawTurns: GameAction[][] = [];

  for (const [index, color] of gameState.publicState.faceUpCards.entries()) {
    const firstDraw: DrawFaceUpAction = {
      kind: "draw-face-up",
      playerId: gameState.ourState.playerId,
      color,
      drawIndex: 1
    };

    if (color === "locomotive") {
      drawTurns.push([firstDraw]);
      continue;
    }

    for (const followUp of getBestFaceUpFollowUps(gameState, index)) {
      drawTurns.push([firstDraw, followUp]);
    }
  }

  const blindFirst: DrawBlindAction = {
    kind: "draw-blind",
    playerId: gameState.ourState.playerId,
    drawIndex: 1
  };

  for (const followUp of getBestFaceUpFollowUps(gameState)) {
    drawTurns.push([blindFirst, followUp]);
  }

  return [...claimTurns, ...drawTicketTurns, ...drawTurns];
};

const aggregateFeatures = (
  features: EvaluationFeatures[]
): EvaluationFeatures => {
  if (features.length === 0) {
    return createBlankFeatures();
  }

  const totals = features.reduce<EvaluationFeatures>(
    (accumulator, current) => ({
      expectedFinalScore: accumulator.expectedFinalScore + current.expectedFinalScore,
      winProbabilityEstimate:
        accumulator.winProbabilityEstimate + current.winProbabilityEstimate,
      scoreDiffEstimate: accumulator.scoreDiffEstimate + current.scoreDiffEstimate,
      routeValue: accumulator.routeValue + current.routeValue,
      ticketValue: accumulator.ticketValue + current.ticketValue,
      tempoValue: accumulator.tempoValue + current.tempoValue,
      flexibilityValue: accumulator.flexibilityValue + current.flexibilityValue,
      riskCost: accumulator.riskCost + current.riskCost,
      blockExposure: accumulator.blockExposure + current.blockExposure,
      trainsRemainingPressure:
        accumulator.trainsRemainingPressure + current.trainsRemainingPressure,
      opponentClockPressure:
        accumulator.opponentClockPressure + current.opponentClockPressure,
      bottleneckUrgency: accumulator.bottleneckUrgency + current.bottleneckUrgency,
      ticketDetourPenalty: accumulator.ticketDetourPenalty + current.ticketDetourPenalty
    }),
    createBlankFeatures()
  );

  return {
    expectedFinalScore: totals.expectedFinalScore / features.length,
    winProbabilityEstimate: totals.winProbabilityEstimate / features.length,
    scoreDiffEstimate: totals.scoreDiffEstimate / features.length,
    routeValue: totals.routeValue / features.length,
    ticketValue: totals.ticketValue / features.length,
    tempoValue: totals.tempoValue / features.length,
    flexibilityValue: totals.flexibilityValue / features.length,
    riskCost: totals.riskCost / features.length,
    blockExposure: totals.blockExposure / features.length,
    trainsRemainingPressure: totals.trainsRemainingPressure / features.length,
    opponentClockPressure: totals.opponentClockPressure / features.length,
    bottleneckUrgency: totals.bottleneckUrgency / features.length,
    ticketDetourPenalty: totals.ticketDetourPenalty / features.length
  };
};

const summarizeTurnRationale = (
  actions: GameAction[],
  actionRecommendations: ActionRecommendation[]
): string[] => {
  if (actions.length === 1 && actions[0]?.kind === "claim-route") {
    return actionRecommendations[0]?.rationale ?? ["claims a route immediately"];
  }

  if (actions.length === 1 && actions[0]?.kind === "draw-tickets") {
    return actionRecommendations[0]?.rationale ?? ["draws more tickets for upside"];
  }

  if (actions.length === 1 && actions[0]?.kind === "keep-tickets") {
    return actionRecommendations[0]?.rationale ?? ["chooses which tickets to keep"];
  }

  const first = actions[0];
  const second = actions[1];
  const lines: string[] = [];

  if (first?.kind === "draw-face-up") {
    lines.push(
      first.color === "locomotive"
        ? "opens with a face-up locomotive for maximum flexibility"
        : `opens with face-up ${first.color}`
    );
  } else if (first?.kind === "draw-blind") {
    lines.push("opens with a blind draw to keep color options wide");
  }

  if (second?.kind === "draw-face-up") {
    lines.push(`follows with face-up ${second.color} to focus the hand`);
  } else if (second?.kind === "draw-blind") {
    lines.push("uses the second draw as another flexible pickup");
  }

  const strongestReason = actionRecommendations
    .flatMap((recommendation) => recommendation.rationale)
    .find((reason) => reason.includes("ticket") || reason.includes("near-ready"));

  if (strongestReason) {
    lines.push(strongestReason);
  }

  return lines;
};

const scoreTurnCandidate = (
  gameState: GameState,
  board: BoardDefinition,
  actions: GameAction[]
): TurnRecommendation => {
  const baseActionEvaluation = recommendActions(gameState, board);
  const firstAction = actions[0];

  if (actions.length === 1 && firstAction?.kind === "keep-tickets") {
    const singleActionRecommendation =
      baseActionEvaluation.alternatives.find(
        (candidate) => candidate.actionId === buildActionId(firstAction)
      );

    if (!singleActionRecommendation) {
      throw new Error(`Could not find recommendation for single-action turn ${firstAction.kind}.`);
    }

    return {
      turnId: buildTurnId(actions),
      actions,
      utilityScore: singleActionRecommendation.utilityScore,
      confidence: singleActionRecommendation.confidence,
      rationale: singleActionRecommendation.rationale,
      featureBreakdown: singleActionRecommendation.featureBreakdown
    };
  }

  const drawnColors = actions.flatMap((action) => {
    if (action.kind === "draw-face-up") {
      return [action.color];
    }

    return [];
  });
  let postTurnBranches: WeightedHandState[] = [{ state: gameState, weight: 1 }];
  for (const action of actions) {
    postTurnBranches = postTurnBranches.flatMap((branch) =>
      applyApproximateActionBranches(board, branch, action)
    );
  }
  const simulatedState = postTurnBranches[0]?.state ?? withAdditionalCards(gameState, drawnColors);
  const simulatedActionEvaluation = recommendActions(simulatedState, board);
  const expectedContinuationClaimUtility = estimateExpectedClaimUtilityAfterActions(
    gameState,
    board,
    actions
  );
  const expectedRolloutContinuationUtility = estimateExpectedClaimUtilityAfterLimitedRollout(
    gameState,
    board,
    actions
  );
  const currentWinProxy = estimatePositionWinChanceProxy(board, gameState);
  const expectedPostTurnWinProxy = estimateExpectedPositionWinChanceAfterActions(
    board,
    gameState,
    actions
  );
  const winProxyDelta = expectedPostTurnWinProxy - currentWinProxy;
  const opponentResponseRisk = postTurnBranches.reduce(
    (sum, branch) =>
      sum + estimateOpponentResponseRiskFromState(board, branch.state).expectedPenalty * branch.weight,
    0
  );
  const representativeOpponentRisk = estimateOpponentResponseRiskFromState(
    board,
    postTurnBranches[0]?.state ?? simulatedState
  );
  const turnDrawTactic = getDrawTacticProfile(
    evaluateTickets(board, gameState).pathDemand,
    gameState.ourState.hand,
    getPlayerPublicState(gameState).claimedRouteIds.length
  );
  const firstDrawAction = actions[0];
  const secondDrawAction = actions[1];
  let duplicateFaceUpFollowThroughAdjustment = 0;
  let duplicateFaceUpFollowThroughReason: string | undefined;
  if (
    firstDrawAction?.kind === "draw-face-up" &&
    firstDrawAction.color !== "locomotive" &&
    gameState.publicState.faceUpCards.filter((color) => color === firstDrawAction.color).length >= 2
  ) {
    if (secondDrawAction?.kind === "draw-face-up" && secondDrawAction.color === firstDrawAction.color) {
      duplicateFaceUpFollowThroughAdjustment += 3.4;
      duplicateFaceUpFollowThroughReason = `follows through by taking the second visible ${firstDrawAction.color}`;
    } else if (secondDrawAction?.kind === "draw-blind") {
      duplicateFaceUpFollowThroughAdjustment -= 8.4;
      duplicateFaceUpFollowThroughReason = `passes on a second visible ${firstDrawAction.color} and goes blind instead`;
    }
  }
  let stepState = gameState;
  const chosenActionEvaluations = actions.map((action) => {
    const currentEvaluation = recommendActions(stepState, board);
    const recommendation = currentEvaluation.alternatives.find(
      (candidate) => candidate.actionId === buildActionId(action)
    );

    if (action.kind === "draw-face-up") {
      stepState = withAdditionalCards(stepState, [action.color]);
    }

    return { recommendation, currentEvaluation };
  });
  let strongerVisibleFollowUpAdjustment = 0;
  let strongerVisibleFollowUpReason: string | undefined;
  if (firstDrawAction?.kind === "draw-face-up" && secondDrawAction?.kind === "draw-blind") {
    const secondStepEvaluation = chosenActionEvaluations[1]?.currentEvaluation;
    const chosenSecondRecommendation = chosenActionEvaluations[1]?.recommendation;
    const bestVisibleFollowUp = secondStepEvaluation?.alternatives
      .filter((candidate) => candidate.action.kind === "draw-face-up")
      .sort((left, right) => right.utilityScore - left.utilityScore)[0];
    if (
      bestVisibleFollowUp &&
      chosenSecondRecommendation &&
      bestVisibleFollowUp.utilityScore > chosenSecondRecommendation.utilityScore + 0.9
    ) {
      const utilityGap = bestVisibleFollowUp.utilityScore - chosenSecondRecommendation.utilityScore;
      strongerVisibleFollowUpAdjustment -= 2.4 + Math.min(2.6, utilityGap * 0.35);
      const visibleFollowUpColor =
        bestVisibleFollowUp.action.kind === "draw-face-up"
        ? bestVisibleFollowUp.action.color
          : "face-up color";
      strongerVisibleFollowUpReason = `goes blind even though visible ${visibleFollowUpColor} looked materially stronger for the second draw`;
    }
  }
  let faceUpThenBlindOpeningAdjustment = 0;
  let faceUpThenBlindOpeningReason: string | undefined;
  if (firstDrawAction?.kind === "draw-face-up" && secondDrawAction?.kind === "draw-blind") {
    const firstStepEvaluation = chosenActionEvaluations[0]?.currentEvaluation;
    const topBlindOpening = firstStepEvaluation?.alternatives.find(
      (candidate) => candidate.action.kind === "draw-blind"
    );
    const firstStepRecommendation = chosenActionEvaluations[0]?.recommendation;
    if (topBlindOpening && firstStepRecommendation) {
      const blindGap = topBlindOpening.utilityScore - firstStepRecommendation.utilityScore;
      const firstWasPriority = turnDrawTactic.priorityColors.has(firstDrawAction.color);
      const remainingVisiblePriority = (() => {
        const firstIndex = gameState.publicState.faceUpCards.indexOf(firstDrawAction.color);
        return gameState.publicState.faceUpCards
          .filter((_, index) => index !== firstIndex)
          .some((color) => turnDrawTactic.priorityColors.has(color));
      })();
      if (turnDrawTactic.mode === "value" && blindGap > -1.6) {
        faceUpThenBlindOpeningAdjustment -=
          (firstWasPriority && !remainingVisiblePriority ? 2.8 : 6.4) +
          Math.max(0, blindGap) * 1.0;
        faceUpThenBlindOpeningReason =
          firstWasPriority && !remainingVisiblePriority
            ? "mixed open-plus-blind draw survives here only because the first visible pick hit a priority color and no other priority color remained visible"
            : "mixed open-plus-blind draw is heavily penalized here because the position still looks more like broad value setup than color focus";
      }
    }
  }
  let valueModeDoubleBlindAdjustment = 0;
  let valueModeDoubleBlindReason: string | undefined;
  if (
    firstDrawAction?.kind === "draw-blind" &&
    secondDrawAction?.kind === "draw-blind" &&
    turnDrawTactic.mode === "value"
  ) {
    valueModeDoubleBlindAdjustment += 6.2;
    valueModeDoubleBlindReason =
      "double-blind draw is rewarded here because the current tactic is still maximizing broad hand value";
  }
  let focusModeVisiblePriorityAdjustment = 0;
  let focusModeVisiblePriorityReason: string | undefined;
  if (firstDrawAction?.kind === "draw-face-up" && secondDrawAction?.kind === "draw-blind") {
    const remainingVisiblePriority = gameState.publicState.faceUpCards
      .filter((_, index) => index !== gameState.publicState.faceUpCards.indexOf(firstDrawAction.color))
      .some((color) => turnDrawTactic.priorityColors.has(color));
    if (turnDrawTactic.mode === "focus" && remainingVisiblePriority) {
      focusModeVisiblePriorityAdjustment -= 7.2;
      focusModeVisiblePriorityReason =
        "goes blind even though another visible priority color was still available in focus mode";
    }
  }
  let genericFaceUpThenBlindAdjustment = 0;
  let genericFaceUpThenBlindReason: string | undefined;
  if (
    firstDrawAction?.kind === "draw-face-up" &&
    secondDrawAction?.kind === "draw-blind" &&
    turnDrawTactic.mode !== "focus"
  ) {
    genericFaceUpThenBlindAdjustment -= 3.2;
    genericFaceUpThenBlindReason =
      "face-up plus blind is broadly discouraged here because the turn is neither fully focused nor fully value-maximizing";
  }
  const chosenActionBreakdowns = chosenActionEvaluations
    .map((entry) => entry.recommendation)
    .filter((entry): entry is ActionRecommendation => Boolean(entry));
  const immediateFeatureBlend = aggregateFeatures(
    chosenActionBreakdowns.map((entry) => entry.featureBreakdown)
  );
  const futureTop = simulatedActionEvaluation.topRecommendation;
  const futureBonus = Math.max(
    futureTop ? futureTop.utilityScore * 0.22 : 0,
    expectedContinuationClaimUtility * 0.28,
    expectedRolloutContinuationUtility * 0.22
  );
  const featureBreakdown: EvaluationFeatures = {
    expectedFinalScore:
      immediateFeatureBlend.expectedFinalScore +
      (futureTop?.featureBreakdown.expectedFinalScore ?? 0) * 0.12 +
      expectedContinuationClaimUtility * 0.08 +
      winProxyDelta * 0.22,
    winProbabilityEstimate: Math.min(
      0.95,
      immediateFeatureBlend.winProbabilityEstimate +
        (futureTop?.featureBreakdown.winProbabilityEstimate ?? 0) * 0.15 +
        expectedContinuationClaimUtility * 0.002 +
        winProxyDelta * 0.008
    ),
    scoreDiffEstimate:
      immediateFeatureBlend.scoreDiffEstimate +
      (futureTop?.featureBreakdown.scoreDiffEstimate ?? 0) * 0.15 +
      expectedContinuationClaimUtility * 0.12 +
      expectedRolloutContinuationUtility * 0.08,
    routeValue:
      immediateFeatureBlend.routeValue +
      (futureTop?.featureBreakdown.routeValue ?? 0) * 0.2 +
      expectedContinuationClaimUtility * 0.18,
    ticketValue:
      immediateFeatureBlend.ticketValue + (futureTop?.featureBreakdown.ticketValue ?? 0) * 0.4,
    tempoValue: immediateFeatureBlend.tempoValue,
    flexibilityValue:
      immediateFeatureBlend.flexibilityValue +
      (futureTop?.featureBreakdown.flexibilityValue ?? 0) * 0.25,
    riskCost: immediateFeatureBlend.riskCost + opponentResponseRisk * 0.4,
    blockExposure: immediateFeatureBlend.blockExposure + opponentResponseRisk * 0.32,
    trainsRemainingPressure: immediateFeatureBlend.trainsRemainingPressure,
    opponentClockPressure:
      immediateFeatureBlend.opponentClockPressure +
      (futureTop?.featureBreakdown.opponentClockPressure ?? 0) * 0.18 -
      opponentResponseRisk * 0.08,
    bottleneckUrgency:
      immediateFeatureBlend.bottleneckUrgency +
      (futureTop?.featureBreakdown.bottleneckUrgency ?? 0) * 0.24,
    ticketDetourPenalty:
      immediateFeatureBlend.ticketDetourPenalty +
      (futureTop?.featureBreakdown.ticketDetourPenalty ?? 0) * 0.22
  };

  return {
    turnId: buildTurnId(actions),
    actions,
    utilityScore:
      immediateFeatureBlend.ticketValue +
      immediateFeatureBlend.flexibilityValue +
      immediateFeatureBlend.tempoValue +
      immediateFeatureBlend.opponentClockPressure * 0.45 +
      immediateFeatureBlend.bottleneckUrgency * 0.6 +
      immediateFeatureBlend.ticketDetourPenalty * 0.38 +
      duplicateFaceUpFollowThroughAdjustment +
      strongerVisibleFollowUpAdjustment +
      faceUpThenBlindOpeningAdjustment +
      valueModeDoubleBlindAdjustment +
      focusModeVisiblePriorityAdjustment +
      genericFaceUpThenBlindAdjustment +
      futureBonus -
      immediateFeatureBlend.riskCost +
      winProxyDelta * 0.18 -
      opponentResponseRisk * 0.55,
    confidence: Math.min(
      0.88,
      0.38 + (futureTop?.confidence ?? 0) * 0.35 + drawnColors.length * 0.08
    ),
    rationale: [
      ...summarizeTurnRationale(
        actions,
        chosenActionBreakdowns.filter(
          (entry): entry is ActionRecommendation => Boolean(entry)
        )
      ),
      winProxyDelta > 0
        ? `improves short-horizon win proxy by ${winProxyDelta.toFixed(1)}`
        : "does not materially improve the short-horizon win proxy",
      representativeOpponentRisk.threatenedRouteId
        ? `still exposes ${representativeOpponentRisk.threatenedRouteId} to opponent pressure`
        : "does not leave an obvious single-route counterplay window",
      ...(duplicateFaceUpFollowThroughReason ? [duplicateFaceUpFollowThroughReason] : []),
      ...(strongerVisibleFollowUpReason ? [strongerVisibleFollowUpReason] : []),
      ...(faceUpThenBlindOpeningReason ? [faceUpThenBlindOpeningReason] : []),
      ...(valueModeDoubleBlindReason ? [valueModeDoubleBlindReason] : []),
      ...(focusModeVisiblePriorityReason ? [focusModeVisiblePriorityReason] : []),
      ...(genericFaceUpThenBlindReason ? [genericFaceUpThenBlindReason] : []),
      expectedRolloutContinuationUtility > 0
        ? `keeps a rollout continuation value of ${expectedRolloutContinuationUtility.toFixed(1)}`
        : "does not keep a strong continuation after this turn"
    ],
    featureBreakdown
  };
};

const buildTurnSimilarityKey = (actions: GameAction[]): string => {
  if (actions.every((action) => action.kind === "claim-route")) {
    const claimAction = actions[0];
    return claimAction?.kind === "claim-route"
      ? `claim:${claimAction.routeId}`
      : buildTurnId(actions);
  }

  if (actions.every((action) => action.kind === "draw-tickets")) {
    return "draw-tickets";
  }

  if (actions.every((action) => action.kind === "keep-tickets")) {
    const keepAction = actions[0];
    return keepAction?.kind === "keep-tickets"
      ? `keep:${[...keepAction.keptTicketIds].sort().join("|")}`
      : buildTurnId(actions);
  }

  const drawTokens = actions.map((action) => {
    switch (action.kind) {
      case "draw-face-up":
        return `face-up:${action.color}`;
      case "draw-blind":
        return "blind";
      default:
        return buildActionId(action);
    }
  });

  return `draw-plan:${drawTokens.sort().join("|")}`;
};

const compactTurnRecommendations = (
  recommendations: TurnRecommendation[]
): TurnRecommendation[] => {
  const bestBySignature = new Map<string, TurnRecommendation>();

  for (const recommendation of recommendations) {
    const signature = buildTurnSimilarityKey(recommendation.actions);
    const existing = bestBySignature.get(signature);

    if (!existing || recommendation.utilityScore > existing.utilityScore) {
      bestBySignature.set(signature, recommendation);
    }
  }

  return [...bestBySignature.values()].sort(
    (left, right) => right.utilityScore - left.utilityScore
  );
};

export const recommendTurns = (
  gameState: GameState,
  board: BoardDefinition
): TurnEvaluation => {
  const baseEvaluation = recommendActions(gameState, board);
  const turnCandidates = buildLegalTurnCandidates(gameState, board);
  const alternatives = compactTurnRecommendations(
    turnCandidates
    .map((candidate) => scoreTurnCandidate(gameState, board, candidate))
    .sort((left, right) => right.utilityScore - left.utilityScore)
  );

  return {
    ...(alternatives[0] ? { topRecommendation: alternatives[0] } : {}),
    alternatives,
    ticketEstimates: baseEvaluation.ticketEstimates,
    routeUrgency: baseEvaluation.routeUrgency
  };
};
