import { TRAIN_COLORS, type PlayerId, type RouteId, type TrainColor } from "../model/board.js";
import type { BoardDefinition } from "../model/board.js";
import type { ClaimRouteAction } from "../model/actions.js";
import type { GameState, PublicPlayerState } from "../model/game-state.js";
import { createBaseRulesConfig } from "../model/game-state.js";
import { indexRoutesById, indexRoutesByParallelGroup } from "../engine/board-index.js";
import { getLongestRouteLength } from "../engine/connectivity.js";
import { getLegalClaimRouteActions } from "../engine/legal-actions.js";
import type { ParsedReplayGame, ReplayParsedEvent } from "./bga-log-parser.js";
import type { ReplayDestinationMetadata } from "./destination-metadata.js";
import { getKnownKeptDestinationsBeforeMove, getSelectionAppliedAtMove } from "./destination-metadata.js";
import {
  analyzeReplayAgainstBoard,
  BGA_TRAIN_CARD_CODE_MAP,
  getReplayClaimTimelineForPlayer,
  type NormalizedClaim
} from "./bga-normalization.js";

export interface ReplayPublicPlayerState {
  playerName: string;
  score: number;
  claimedRouteIds: RouteId[];
  trainsRemaining: number;
  visibleDrawCount: number;
  hiddenDrawCount: number;
  destinationKeepEvents: number;
}

export interface ReplaySelfKnownState {
  playerName: string;
  exactKnownCards: Record<TrainColor, number>;
  unknownHiddenDrawCount: number;
}

export interface ReplayStateSnapshot {
  moveNumber: number;
  timestamp: string;
  actors: string[];
  eventKinds: ReplayParsedEvent["kind"][];
  players: ReplayPublicPlayerState[];
  claimedRoutes: Record<RouteId, PlayerId>;
  finalTurnTriggeredBy?: string;
  selfKnownState?: ReplaySelfKnownState;
}

export interface ReplayReconstruction {
  snapshots: ReplayStateSnapshot[];
  finalSnapshot: ReplayStateSnapshot;
}

export interface ReplayChosenActionSummary {
  kind:
    | "draw-visible"
    | "draw-hidden"
    | "claim-route"
    | "keep-destinations"
    | "mixed"
    | "unknown";
  routeId?: string;
  cardCodes?: number[];
  drawCount?: number;
}

export interface ReplayDecisionSnapshot {
  moveNumber: number;
  timestamp: string;
  playerName: string;
  preMoveSnapshot: ReplayStateSnapshot;
  chosenAction: ReplayChosenActionSummary;
  legalClaimActions: ClaimRouteAction[];
  features: ReplayDecisionFeatures;
  knownDestinations: string[];
  destinationSelectionApplied?: {
    offered?: string[];
    kept: string[];
  };
}

export interface ReplayDecisionFeatures {
  currentScore: number;
  trainsRemaining: number;
  knownHandSize: number;
  knownColorDiversity: number;
  visibleDrawCountSoFar: number;
  hiddenDrawCountSoFar: number;
  claimedRouteCount: number;
  currentLongestRouteLength: number;
  legalClaimCount: number;
  maxLegalClaimLength: number;
  maxLegalClaimPoints: number;
  availableSixLengthClaims: number;
  availableLocomotiveClaims: number;
  completedDestinationCountSoFar: number;
}

const zeroCardCounts = (): Record<TrainColor, number> => ({
  red: 0,
  blue: 0,
  green: 0,
  yellow: 0,
  black: 0,
  white: 0,
  orange: 0,
  pink: 0,
  locomotive: 0
});

const cloneCardCounts = (
  counts: Record<TrainColor, number>
): Record<TrainColor, number> => ({ ...counts });

const addKnownCardCode = (
  counts: Record<TrainColor, number>,
  cardCode: number
): void => {
  const color = BGA_TRAIN_CARD_CODE_MAP[cardCode];

  if (!color) {
    return;
  }

  counts[color] += 1;
};

const spendKnownClaimCards = (
  counts: Record<TrainColor, number>,
  claim: NormalizedClaim
): void => {
  for (const color of claim.decodedCardColors) {
    if (counts[color] > 0) {
      counts[color] -= 1;
    }
  }
};

const decodeKnownCardCodes = (cardCodes: number[]): TrainColor[] =>
  cardCodes.flatMap((cardCode) => {
    const color = BGA_TRAIN_CARD_CODE_MAP[cardCode];
    return color ? [color] : [];
  });

const clonePlayers = (
  players: ReplayPublicPlayerState[]
): ReplayPublicPlayerState[] => players.map((player) => ({ ...player, claimedRouteIds: [...player.claimedRouteIds] }));

export const reconstructReplayState = (
  parsedReplay: ParsedReplayGame,
  board: BoardDefinition,
  selfPlayerName?: string
): ReplayReconstruction => {
  const analysis = analyzeReplayAgainstBoard(parsedReplay, board);

  const playersState = new Map<string, ReplayPublicPlayerState>(
    parsedReplay.players.map((playerName) => [
      playerName,
      {
        playerName,
        score: 0,
        claimedRouteIds: [],
        trainsRemaining: 45,
        visibleDrawCount: 0,
        hiddenDrawCount: 0,
        destinationKeepEvents: 0
      }
    ])
  );

  const claimedRoutes: Record<RouteId, PlayerId> = {};
  const selfKnownState: ReplaySelfKnownState | undefined = selfPlayerName
    ? {
        playerName: selfPlayerName,
        exactKnownCards: zeroCardCounts(),
        unknownHiddenDrawCount: 0
      }
    : undefined;
  let finalTurnTriggeredBy: string | undefined;
  const snapshots: ReplayStateSnapshot[] = [];

  for (const move of parsedReplay.moves) {
    for (const event of move.events) {
      switch (event.kind) {
        case "keep-destinations": {
          const player = playersState.get(event.playerName);
          if (player) {
            player.destinationKeepEvents += 1;
          }
          break;
        }
        case "draw-visible": {
          const player = playersState.get(event.playerName);
          if (player) {
            player.visibleDrawCount += 1;
          }

          if (selfKnownState && event.playerName === selfKnownState.playerName) {
            addKnownCardCode(selfKnownState.exactKnownCards, event.cardCode);
          }
          break;
        }
        case "draw-hidden": {
          const player = playersState.get(event.playerName);
          if (player) {
            player.hiddenDrawCount += 1;
          }

          if (selfKnownState && event.playerName === selfKnownState.playerName) {
            for (const cardCode of event.cardCodes) {
              if (cardCode >= 0) {
                addKnownCardCode(selfKnownState.exactKnownCards, cardCode);
              } else {
                selfKnownState.unknownHiddenDrawCount += 1;
              }
            }
          }
          break;
        }
        case "claim-route": {
          const player = playersState.get(event.playerName);
          const eventDecodedColors = decodeKnownCardCodes(event.cardCodes);
          const matchedClaim = analysis.claims.find((claim) =>
            claim.playerName === event.playerName &&
            claim.points === event.points &&
            claim.trainCarsUsed === event.trainCarsUsed &&
            claim.decodedCardColors.length === eventDecodedColors.length &&
            claim.decodedCardColors.every(
              (color, index) => color === eventDecodedColors[index]
            )
          );

          if (player) {
            player.score += event.points;
            player.trainsRemaining -= event.trainCarsUsed;
            if (matchedClaim?.routeId) {
              player.claimedRouteIds.push(matchedClaim.routeId);
              claimedRoutes[matchedClaim.routeId] = event.playerName;
            }
          }

          if (
            selfKnownState &&
            event.playerName === selfKnownState.playerName &&
            matchedClaim
          ) {
            spendKnownClaimCards(selfKnownState.exactKnownCards, matchedClaim);
          }
          break;
        }
        case "reveal-destination": {
          if (event.deltaPoints !== 0) {
            const player = playersState.get(event.playerName);
            if (player) {
              player.score += event.deltaPoints;
            }
          }
          break;
        }
        case "longest-path-bonus": {
          const player = playersState.get(event.playerName);
          if (player) {
            player.score += event.points;
          }
          break;
        }
        case "final-turn-trigger":
          finalTurnTriggeredBy = event.playerName;
          break;
        default:
          break;
      }
    }

    const actors = [...new Set(move.events.flatMap((event) => ("playerName" in event ? [event.playerName] : [])))];
    snapshots.push({
      moveNumber: move.header.moveNumber,
      timestamp: move.header.timestamp,
      actors,
      eventKinds: move.events.map((event) => event.kind),
      players: clonePlayers([...playersState.values()]),
      claimedRoutes: { ...claimedRoutes },
      ...(finalTurnTriggeredBy ? { finalTurnTriggeredBy } : {}),
      ...(selfKnownState
        ? {
            selfKnownState: {
              playerName: selfKnownState.playerName,
              exactKnownCards: cloneCardCounts(selfKnownState.exactKnownCards),
              unknownHiddenDrawCount: selfKnownState.unknownHiddenDrawCount
            }
          }
        : {})
    });
  }

  const finalSnapshot = snapshots[snapshots.length - 1];

  if (!finalSnapshot) {
    throw new Error("Replay did not produce any snapshots.");
  }

  return {
    snapshots,
    finalSnapshot
  };
};

export const getKnownSelfClaims = (
  parsedReplay: ParsedReplayGame,
  board: BoardDefinition,
  selfPlayerName: string
): NormalizedClaim[] =>
  getReplayClaimTimelineForPlayer(
    analyzeReplayAgainstBoard(parsedReplay, board),
    selfPlayerName
  );

const toReplayPublicPlayer = (
  players: ReplayPublicPlayerState[]
): PublicPlayerState[] =>
  players.map((player) => ({
    playerId: player.playerName,
    displayName: player.playerName,
    score: player.score,
    trainsRemaining: player.trainsRemaining,
    claimedRouteIds: [...player.claimedRouteIds],
    ticketsDrawnCount: player.destinationKeepEvents
  }));

const toApproximateGameState = (
  snapshot: ReplayStateSnapshot,
  playerName: string
): GameState | undefined => {
  const selfState = snapshot.selfKnownState;
  const publicPlayer = snapshot.players.find((player) => player.playerName === playerName);

  if (!selfState || !publicPlayer) {
    return undefined;
  }

  return {
    rules: createBaseRulesConfig(snapshot.players.length as 2 | 3 | 4 | 5),
    publicState: {
      currentPlayerId: playerName,
      firstPlayerId: snapshot.players[0]?.playerName ?? playerName,
      turnNumber: snapshot.moveNumber,
      phase: "ready",
      playerOrder: snapshot.players.map((player) => player.playerName),
      players: toReplayPublicPlayer(snapshot.players),
      faceUpCards: [],
      discardCount: 0,
      drawPileCount: 0,
      claimedRoutes: { ...snapshot.claimedRoutes },
      ...(snapshot.finalTurnTriggeredBy
        ? { lastRoundTriggeredBy: snapshot.finalTurnTriggeredBy }
        : {})
    },
    ourState: {
      playerId: playerName,
      trainsRemaining: publicPlayer.trainsRemaining,
      hand: { ...selfState.exactKnownCards },
      ticketIds: []
    },
    beliefs: [],
    annotations: {
      activePlanTags: [],
      securedTicketIds: [],
      atRiskTicketIds: [],
      bottleneckRouteIds: []
    }
  };
};

const summarizeChosenAction = (
  moveEvents: ReplayParsedEvent[],
  playerName: string,
  analysis: ReturnType<typeof analyzeReplayAgainstBoard>
): ReplayChosenActionSummary => {
  const playerEvents = moveEvents.filter(
    (event) => "playerName" in event && event.playerName === playerName
  );
  const actionablePlayerEvents = playerEvents.filter((event) =>
    event.kind === "draw-visible" ||
    event.kind === "draw-hidden" ||
    event.kind === "claim-route" ||
    event.kind === "keep-destinations"
  );

  if (actionablePlayerEvents.length === 0) {
    return { kind: "unknown" };
  }

  if (actionablePlayerEvents.every((event) => event.kind === "draw-visible")) {
    return {
      kind: "draw-visible",
      drawCount: actionablePlayerEvents.length,
      cardCodes: actionablePlayerEvents.flatMap((event) =>
        event.kind === "draw-visible" ? [event.cardCode] : []
      )
    };
  }

  if (actionablePlayerEvents.every((event) => event.kind === "draw-hidden")) {
    return {
      kind: "draw-hidden",
      drawCount: actionablePlayerEvents.reduce(
        (count, event) =>
          count + (event.kind === "draw-hidden" ? event.cardCodes.length : 0),
        0
      ),
      cardCodes: actionablePlayerEvents.flatMap((event) =>
        event.kind === "draw-hidden" ? event.cardCodes : []
      )
    };
  }

  if (
    actionablePlayerEvents.length === 1 &&
    actionablePlayerEvents[0]?.kind === "keep-destinations"
  ) {
    return {
      kind: "keep-destinations"
    };
  }

  const claimEvent = actionablePlayerEvents.find(
    (event): event is Extract<ReplayParsedEvent, { kind: "claim-route" }> =>
      event.kind === "claim-route"
  );

  if (claimEvent) {
    const decodedColors = decodeKnownCardCodes(claimEvent.cardCodes);
    const matchedClaim = analysis.claims.find((claim) =>
      claim.playerName === playerName &&
      claim.points === claimEvent.points &&
      claim.trainCarsUsed === claimEvent.trainCarsUsed &&
      claim.decodedCardColors.length === decodedColors.length &&
      claim.decodedCardColors.every((color, index) => color === decodedColors[index])
    );

    return {
      kind: "claim-route",
      cardCodes: claimEvent.cardCodes,
      ...(matchedClaim?.routeId ? { routeId: matchedClaim.routeId } : {})
    };
  }

  return { kind: "mixed" };
};

const buildDecisionFeatures = (
  snapshot: ReplayStateSnapshot,
  playerName: string,
  legalClaimActions: ClaimRouteAction[],
  board: BoardDefinition,
  completedDestinationCountSoFar: number
): ReplayDecisionFeatures => {
  const publicPlayer = snapshot.players.find((player) => player.playerName === playerName);
  const knownHand = snapshot.selfKnownState?.exactKnownCards ?? zeroCardCounts();
  const routesById = indexRoutesById(board.routes);
  const legalClaimRoutes = legalClaimActions
    .map((action) => routesById.get(action.routeId))
    .filter((route): route is NonNullable<typeof route> => Boolean(route));
  const currentLongestRouteLength = getLongestRouteLength(
    {
      currentPlayerId: playerName,
      firstPlayerId: snapshot.players[0]?.playerName ?? playerName,
      turnNumber: snapshot.moveNumber,
      phase: "ready",
      playerOrder: snapshot.players.map((player) => player.playerName),
      players: toReplayPublicPlayer(snapshot.players),
      faceUpCards: [],
      discardCount: 0,
      drawPileCount: 0,
      claimedRoutes: snapshot.claimedRoutes,
      ...(snapshot.finalTurnTriggeredBy
        ? { lastRoundTriggeredBy: snapshot.finalTurnTriggeredBy }
        : {})
    },
    playerName,
    routesById
  );

  return {
    currentScore: publicPlayer?.score ?? 0,
    trainsRemaining: publicPlayer?.trainsRemaining ?? 0,
    knownHandSize: Object.values(knownHand).reduce((sum, count) => sum + count, 0),
    knownColorDiversity: Object.values(knownHand).filter((count) => count > 0).length,
    visibleDrawCountSoFar: publicPlayer?.visibleDrawCount ?? 0,
    hiddenDrawCountSoFar: publicPlayer?.hiddenDrawCount ?? 0,
    claimedRouteCount: publicPlayer?.claimedRouteIds.length ?? 0,
    currentLongestRouteLength,
    legalClaimCount: legalClaimActions.length,
    maxLegalClaimLength: legalClaimRoutes.reduce(
      (maxLength, route) => Math.max(maxLength, route.length),
      0
    ),
    maxLegalClaimPoints: legalClaimRoutes.reduce(
      (maxPoints, route) => Math.max(maxPoints, route.points),
      0
    ),
    availableSixLengthClaims: legalClaimRoutes.filter((route) => route.length === 6).length,
    availableLocomotiveClaims: legalClaimActions.filter(
      (action) => action.payment.locomotives > 0
    ).length,
    completedDestinationCountSoFar
  };
};

export const extractDecisionSnapshots = (
  parsedReplay: ParsedReplayGame,
  board: BoardDefinition,
  selfPlayerName: string,
  destinationMetadata?: ReplayDestinationMetadata
): ReplayDecisionSnapshot[] => {
  const reconstruction = reconstructReplayState(parsedReplay, board, selfPlayerName);
  const analysis = analyzeReplayAgainstBoard(parsedReplay, board);
  const routesByParallelGroup = indexRoutesByParallelGroup(board.routes);
  const decisions: ReplayDecisionSnapshot[] = [];
  const firstSnapshot = reconstruction.snapshots[0];
  let completedDestinationCountSoFar = 0;

  if (!firstSnapshot) {
    return decisions;
  }

  for (let index = 0; index < parsedReplay.moves.length; index += 1) {
    const move = parsedReplay.moves[index];
    if (!move) {
      continue;
    }
    const actors = new Set(
      move.events.flatMap((event) => ("playerName" in event ? [event.playerName] : []))
    );

    if (!actors.has(selfPlayerName)) {
      completedDestinationCountSoFar += move.events.filter(
        (event) =>
          event.kind === "completed-destination" && event.playerName === selfPlayerName
      ).length;
      continue;
    }

    const preMoveSnapshot =
      index === 0
        ? {
            moveNumber: 0,
            timestamp: "pre-game",
            actors: [],
            eventKinds: [],
            players: firstSnapshot.players.map((player) => ({
              ...player,
              score: 0,
              claimedRouteIds: [],
              trainsRemaining: 45,
              visibleDrawCount: 0,
              hiddenDrawCount: 0,
              destinationKeepEvents: 0
            })),
            claimedRoutes: {},
            ...(firstSnapshot.selfKnownState
              ? {
                  selfKnownState: {
                    playerName: selfPlayerName,
                    exactKnownCards: zeroCardCounts(),
                    unknownHiddenDrawCount: 0
                  }
                }
              : {})
          }
        : reconstruction.snapshots[index - 1] ?? firstSnapshot;

    const approximateGameState = toApproximateGameState(preMoveSnapshot, selfPlayerName);
    const legalClaimActions = approximateGameState
      ? getLegalClaimRouteActions(
          approximateGameState,
          board.routes,
          routesByParallelGroup
        )
      : [];
    const chosenAction = summarizeChosenAction(move.events, selfPlayerName, analysis);

    if (chosenAction.kind === "unknown") {
      completedDestinationCountSoFar += move.events.filter(
        (event) =>
          event.kind === "completed-destination" && event.playerName === selfPlayerName
      ).length;
      continue;
    }

    const features = buildDecisionFeatures(
      preMoveSnapshot,
      selfPlayerName,
      legalClaimActions,
      board,
      completedDestinationCountSoFar
    );

    decisions.push({
      moveNumber: move.header.moveNumber,
      timestamp: move.header.timestamp,
      playerName: selfPlayerName,
      preMoveSnapshot,
      chosenAction,
      legalClaimActions,
      features,
      knownDestinations: destinationMetadata
        ? getKnownKeptDestinationsBeforeMove(
            destinationMetadata,
            selfPlayerName,
            move.header.moveNumber
          )
        : [],
      ...(destinationMetadata
        ? (() => {
            const selection = getSelectionAppliedAtMove(
              destinationMetadata,
              selfPlayerName,
              move.header.moveNumber
            );

            return selection
              ? {
                  destinationSelectionApplied: {
                    ...(selection.offered ? { offered: selection.offered } : {}),
                    kept: selection.kept
                  }
                }
              : {};
          })()
        : {})
    });

    completedDestinationCountSoFar += move.events.filter(
      (event) =>
        event.kind === "completed-destination" && event.playerName === selfPlayerName
    ).length;
  }

  return decisions;
};
