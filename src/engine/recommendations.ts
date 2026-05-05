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

const getPlayerPublicState = (gameState: GameState) => {
  const player = gameState.publicState.players.find(
    (candidate) => candidate.playerId === gameState.ourState.playerId
  );

  if (!player) {
    throw new Error("Could not find current player in public player state.");
  }

  return player;
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

  for (const ticket of tickets) {
    const pathEvaluation = evaluateTicketPath(
      board,
      gameState.publicState,
      gameState.ourState.playerId,
      ticket
    );

    for (const step of pathEvaluation.path) {
      const supportingSignals: string[] = [];

      if (step.length >= 5) {
        supportingSignals.push("long critical segment");
      }

      if (gameState.annotations.bottleneckRouteIds.includes(step.routeId)) {
        supportingSignals.push("annotated bottleneck");
      }

      if (supportingSignals.length === 0) {
        continue;
      }

      urgentRoutes.set(step.routeId, {
        routeId: step.routeId,
        loseBeforeNextTurnProbability: Math.min(
          0.85,
          0.2 + step.length * 0.08 + supportingSignals.length * 0.08
        ),
        supportingSignals
      });
    }
  }

  return [...urgentRoutes.values()].sort(
    (left, right) => right.loseBeforeNextTurnProbability - left.loseBeforeNextTurnProbability
  );
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
  trainsRemainingPressure: 0
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
  const locomotiveSpendPenalty = action.payment.locomotives * 0.9;
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
    routeValue: route.points + efficiency * 2 + urgency * 8,
    ticketValue: ticketProgressDelta * 1.5 + completionDelta * 8,
    tempoValue: route.length >= 5 ? 3.5 : route.length >= 3 ? 2 : 0.8,
    flexibilityValue: Math.max(0, 5 - action.payment.locomotives * 1.2),
    riskCost: locomotiveSpendPenalty + Math.max(0, -ticketProgressDelta * 0.3),
    blockExposure: urgency * 5,
    trainsRemainingPressure:
      gameState.ourState.trainsRemaining <= 12 ? route.length * 0.9 : route.length * 0.2
  };

  const utilityScore =
    featureBreakdown.routeValue +
    featureBreakdown.ticketValue +
    featureBreakdown.tempoValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.blockExposure +
    featureBreakdown.trainsRemainingPressure -
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
    urgency > 0.35
      ? "secures a route that looks time-sensitive"
      : "route urgency is moderate"
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
  const remainingCandidates = getUnknownTickets(board, gameState);
  const bestCandidateValues = remainingCandidates
    .map((ticket) => ({
      ticket,
      value: estimateTicketStandaloneValue(board, gameState, ticket)
    }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 3);
  const expectedTicketGain =
    bestCandidateValues.reduce((sum, entry) => sum + entry.value, 0) /
    Math.max(bestCandidateValues.length, 1);
  const safeToDrawFactor =
    gameState.ourState.trainsRemaining >= 18
      ? 1
      : gameState.ourState.trainsRemaining >= 12
        ? 0.55
        : 0.15;
  const completionRatio =
    currentTickets.length > 0 ? completedTickets / currentTickets.length : 1;
  const featureBreakdown: EvaluationFeatures = {
    ...createBlankFeatures(),
    expectedFinalScore: getPlayerPublicState(gameState).score + expectedTicketGain * 0.6,
    winProbabilityEstimate: Math.min(
      0.82,
      0.22 + expectedTicketGain * 0.015 + safeToDrawFactor * 0.18 + completionRatio * 0.08
    ),
    scoreDiffEstimate: expectedTicketGain * 0.45,
    routeValue: 0.3,
    ticketValue: expectedTicketGain * safeToDrawFactor,
    tempoValue: safeToDrawFactor > 0.5 ? 1.6 : 0.4,
    flexibilityValue: 2.1 + safeToDrawFactor * 1.4,
    riskCost: (1 - safeToDrawFactor) * 5.5,
    blockExposure: 0.4,
    trainsRemainingPressure: safeToDrawFactor > 0.5 ? 0.5 : -2.4
  };

  return {
    action,
    actionId: buildActionId(action),
    utilityScore:
      featureBreakdown.ticketValue +
      featureBreakdown.flexibilityValue +
      featureBreakdown.tempoValue -
      featureBreakdown.riskCost,
    confidence: Math.min(0.78, 0.3 + safeToDrawFactor * 0.3 + completionRatio * 0.15),
    rationale: [
      completionRatio >= 0.75
        ? "current ticket slate is mostly stabilized, so adding upside is reasonable"
        : "draws fresh tickets before current routes fully lock in",
      safeToDrawFactor > 0.5
        ? "there are still enough trains left to absorb an extra objective"
        : "late timing makes extra tickets risky",
      ...bestCandidateValues
        .slice(0, 2)
        .map(
          (entry) =>
            `top unseen candidate: ${formatTicketLabel(board, entry.ticket)} (${entry.value.toFixed(1)})`
        ),
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
  const neededWeight = getNeededColorWeight(
    action.color,
    colorDemand,
    gameState.ourState.hand
  );
  const nearReadyClaims = countNearReadyClaims(board, gameState, action.color);
  const isLocomotive = action.color === "locomotive";
  const helpedTickets = getTicketsNeedingColor(board, gameState, action.color);
  const featureBreakdown: EvaluationFeatures = {
    ...createBlankFeatures(),
    expectedFinalScore: getPlayerPublicState(gameState).score + neededWeight * 0.8,
    winProbabilityEstimate: Math.min(
      0.85,
      0.35 + neededWeight * 0.03 + nearReadyClaims * 0.015 + (isLocomotive ? 0.12 : 0)
    ),
    scoreDiffEstimate: neededWeight * 0.6 + nearReadyClaims * 0.5,
    routeValue: nearReadyClaims * 0.8,
    ticketValue: neededWeight * 1.4,
    tempoValue: isLocomotive ? 2.6 : 1.1,
    flexibilityValue: isLocomotive ? 5.5 : neededWeight * 0.7 + 1.5,
    riskCost: isLocomotive ? 0.8 : 0.3,
    blockExposure: 0,
    trainsRemainingPressure: 0
  };

  const utilityScore =
    featureBreakdown.ticketValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.tempoValue +
    featureBreakdown.routeValue -
    featureBreakdown.riskCost;

  const rationale = [
    isLocomotive
      ? "takes a wildcard that stays live across many plans"
      : `adds ${action.color} toward currently shortest ticket paths`,
    ...helpedTickets.map((ticketLabel) => `supports ${ticketLabel}`),
    nearReadyClaims > 0
      ? `opens or strengthens ${nearReadyClaims} near-ready claim options`
      : "is mostly a setup draw rather than an immediate claim enabler",
    neededWeight > 0
      ? `matches current route-color demand weight ${neededWeight.toFixed(1)}`
      : "is not a top-demand color for current tickets"
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
  const activeTicketLabels = getTicketProgressStates(board, gameState)
    .filter((ticketState) => !ticketState.completed)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 2)
    .map((ticketState) => formatTicketLabel(board, ticketState.ticket));
  const drawPilePressure =
    gameState.publicState.drawPileCount > 25 ? 1.8 : gameState.publicState.drawPileCount > 10 ? 1.2 : 0.6;
  const featureBreakdown: EvaluationFeatures = {
    ...createBlankFeatures(),
    expectedFinalScore: getPlayerPublicState(gameState).score + totalDemand * 0.25,
    winProbabilityEstimate: Math.min(0.72, 0.28 + totalDemand * 0.01 + drawPilePressure * 0.05),
    scoreDiffEstimate: totalDemand * 0.15,
    routeValue: 0,
    ticketValue: totalDemand * 0.35,
    tempoValue: 0.9,
    flexibilityValue: 2.2 + drawPilePressure,
    riskCost: 0.2,
    blockExposure: 0,
    trainsRemainingPressure: 0
  };

  const utilityScore =
    featureBreakdown.ticketValue +
    featureBreakdown.flexibilityValue +
    featureBreakdown.tempoValue -
    featureBreakdown.riskCost;

  return {
    action,
    actionId: buildActionId(action),
    utilityScore,
    confidence: 0.32,
    rationale: [
      "keeps color options open when no single face-up card dominates",
      ...activeTicketLabels.map((ticketLabel) => `stays live for ${ticketLabel}`),
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
        const riskCost = Math.max(0, action.keptTicketIds.length - 1) * 1.25;
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
          trainsRemainingPressure: -riskCost * 0.25
        };

        return {
          action,
          actionId: buildActionId(action),
          utilityScore: utilityScore - riskCost,
          confidence: Math.min(0.84, 0.45 + keptTickets.length * 0.08),
          rationale: [
            `keeps ${keptTickets.length} ticket${keptTickets.length > 1 ? "s" : ""}`,
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
                  `${formatTicketLabel(board, ticket)} looks relatively efficient from the current network`
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

const getBestFaceUpFollowUps = (
  gameState: GameState,
  firstDrawColor?: TrainColor
): Array<DrawFaceUpAction | DrawBlindAction> => {
  const remainingFaceUp = gameState.publicState.faceUpCards.filter(
    (color) => color !== firstDrawColor
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

  for (const color of gameState.publicState.faceUpCards) {
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

    for (const followUp of getBestFaceUpFollowUps(gameState, color)) {
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
        accumulator.trainsRemainingPressure + current.trainsRemainingPressure
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
    trainsRemainingPressure: totals.trainsRemainingPressure / features.length
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

  if (
    actions.length === 1 &&
    (firstAction?.kind === "claim-route" ||
      firstAction?.kind === "draw-tickets" ||
      firstAction?.kind === "keep-tickets")
  ) {
    const singleActionRecommendation =
      firstAction.kind === "claim-route"
        ? scoreClaimAction(
            board,
            gameState,
            firstAction,
            baseActionEvaluation.routeUrgency
          )
        : baseActionEvaluation.alternatives.find(
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
  const simulatedState = withAdditionalCards(gameState, drawnColors);
  const simulatedActionEvaluation = recommendActions(simulatedState, board);
  let stepState = gameState;
  const chosenActionBreakdowns = actions.map((action) => {
    const currentEvaluation = recommendActions(stepState, board);
    const recommendation = currentEvaluation.alternatives.find(
      (candidate) => candidate.actionId === buildActionId(action)
    );

    if (action.kind === "draw-face-up") {
      stepState = withAdditionalCards(stepState, [action.color]);
    }

    return recommendation;
  });
  const immediateFeatureBlend = aggregateFeatures(
    chosenActionBreakdowns
      .filter((entry): entry is ActionRecommendation => Boolean(entry))
      .map((entry) => entry.featureBreakdown)
  );
  const futureTop = simulatedActionEvaluation.topRecommendation;
  const futureBonus = futureTop ? futureTop.utilityScore * 0.35 : 0;
  const featureBreakdown: EvaluationFeatures = {
    expectedFinalScore:
      immediateFeatureBlend.expectedFinalScore +
      (futureTop?.featureBreakdown.expectedFinalScore ?? 0) * 0.15,
    winProbabilityEstimate: Math.min(
      0.95,
      immediateFeatureBlend.winProbabilityEstimate +
        (futureTop?.featureBreakdown.winProbabilityEstimate ?? 0) * 0.2
    ),
    scoreDiffEstimate:
      immediateFeatureBlend.scoreDiffEstimate +
      (futureTop?.featureBreakdown.scoreDiffEstimate ?? 0) * 0.2,
    routeValue:
      immediateFeatureBlend.routeValue + (futureTop?.featureBreakdown.routeValue ?? 0) * 0.25,
    ticketValue:
      immediateFeatureBlend.ticketValue + (futureTop?.featureBreakdown.ticketValue ?? 0) * 0.4,
    tempoValue: immediateFeatureBlend.tempoValue,
    flexibilityValue:
      immediateFeatureBlend.flexibilityValue +
      (futureTop?.featureBreakdown.flexibilityValue ?? 0) * 0.25,
    riskCost: immediateFeatureBlend.riskCost,
    blockExposure: immediateFeatureBlend.blockExposure,
    trainsRemainingPressure: immediateFeatureBlend.trainsRemainingPressure
  };

  return {
    turnId: buildTurnId(actions),
    actions,
    utilityScore:
      immediateFeatureBlend.ticketValue +
      immediateFeatureBlend.flexibilityValue +
      immediateFeatureBlend.tempoValue +
      futureBonus -
      immediateFeatureBlend.riskCost,
    confidence: Math.min(
      0.88,
      0.38 + (futureTop?.confidence ?? 0) * 0.35 + drawnColors.length * 0.08
    ),
    rationale: summarizeTurnRationale(
      actions,
      chosenActionBreakdowns.filter(
        (entry): entry is ActionRecommendation => Boolean(entry)
      )
    ),
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
