import type { ClaimRoutePayment } from "../model/actions.js";
import type {
  PlayerId,
  RouteDefinition,
  TrainColor
} from "../model/board.js";
import type { GameState, PrivatePlayerState } from "../model/game-state.js";
import { getRoutePoints } from "./scoring.js";

export interface RouteClaimCheck {
  ok: boolean;
  reason?: string;
}

const NON_WILD_COLORS: Array<Exclude<TrainColor, "locomotive">> = [
  "red",
  "blue",
  "green",
  "yellow",
  "black",
  "white",
  "orange",
  "pink"
];

export const canUsePaymentOnRoute = (
  route: RouteDefinition,
  payment: ClaimRoutePayment
): RouteClaimCheck => {
  if (payment.colorCards < 0 || payment.locomotives < 0) {
    return { ok: false, reason: "Payment counts cannot be negative." };
  }

  if (payment.colorCards + payment.locomotives !== route.length) {
    return { ok: false, reason: "Payment must match route length exactly." };
  }

  if (route.color !== "gray" && payment.primaryColor !== route.color) {
    return { ok: false, reason: "Colored route requires matching card color." };
  }

  return { ok: true };
};

export const countCardsUsableForRoute = (
  hand: PrivatePlayerState["hand"],
  route: RouteDefinition,
  color: Exclude<TrainColor, "locomotive">
): number => {
  if (route.color !== "gray" && route.color !== color) {
    return 0;
  }

  return (hand[color] ?? 0) + (hand.locomotive ?? 0);
};

export const listClaimableColorsForGrayRoute = (
  hand: PrivatePlayerState["hand"],
  route: RouteDefinition
): Array<Exclude<TrainColor, "locomotive">> => {
  if (route.color !== "gray") {
    return [];
  }

  return NON_WILD_COLORS.filter(
    (color) => countCardsUsableForRoute(hand, route, color) >= route.length
  );
};

export const canPlayerAffordRoute = (
  hand: PrivatePlayerState["hand"],
  route: RouteDefinition,
  payment: ClaimRoutePayment
): RouteClaimCheck => {
  const paymentCheck = canUsePaymentOnRoute(route, payment);

  if (!paymentCheck.ok) {
    return paymentCheck;
  }

  if ((hand[payment.primaryColor] ?? 0) < payment.colorCards) {
    return { ok: false, reason: "Not enough color cards in hand." };
  }

  if ((hand.locomotive ?? 0) < payment.locomotives) {
    return { ok: false, reason: "Not enough locomotives in hand." };
  }

  return { ok: true };
};

export const isDoubleRouteBlocked = (
  gameState: GameState,
  route: RouteDefinition,
  routesByParallelGroup: Map<string, RouteDefinition[]>
): boolean => {
  if (!route.isDoubleRoute || !route.parallelGroup) {
    return false;
  }

  if (!gameState.rules.doubleRoutesBlockedInTwoThreePlayer) {
    return false;
  }

  const siblingRoutes = routesByParallelGroup.get(route.parallelGroup) ?? [];

  return siblingRoutes.some((candidate) => {
    const owner = gameState.publicState.claimedRoutes[candidate.id];
    return Boolean(owner);
  });
};

export const canClaimRoute = (
  gameState: GameState,
  actingPlayerId: PlayerId,
  route: RouteDefinition,
  payment: ClaimRoutePayment,
  routesByParallelGroup: Map<string, RouteDefinition[]>
): RouteClaimCheck => {
  if (gameState.publicState.currentPlayerId !== actingPlayerId) {
    return { ok: false, reason: "It is not this player's turn." };
  }

  if (gameState.publicState.phase !== "ready") {
    return { ok: false, reason: "Route claims are only legal in ready phase." };
  }

  if (gameState.ourState.playerId !== actingPlayerId) {
    return {
      ok: false,
      reason: "Current local validator only supports our own route claims."
    };
  }

  if (gameState.publicState.claimedRoutes[route.id]) {
    return { ok: false, reason: "Route is already claimed." };
  }

  if (gameState.ourState.trainsRemaining < route.length) {
    return { ok: false, reason: "Not enough trains remaining." };
  }

  if (isDoubleRouteBlocked(gameState, route, routesByParallelGroup)) {
    return { ok: false, reason: "Parallel double route is blocked." };
  }

  return canPlayerAffordRoute(gameState.ourState.hand, route, payment);
};

export interface AppliedClaimRouteResult {
  updatedState: GameState;
  pointsAwarded: number;
}

export const applyOwnRouteClaim = (
  gameState: GameState,
  route: RouteDefinition,
  payment: ClaimRoutePayment
): AppliedClaimRouteResult => {
  const pointsAwarded = getRoutePoints(route.length);

  return {
    pointsAwarded,
    updatedState: {
      ...gameState,
      publicState: {
        ...gameState.publicState,
        phase: "finished",
        claimedRoutes: {
          ...gameState.publicState.claimedRoutes,
          [route.id]: gameState.ourState.playerId
        },
        players: gameState.publicState.players.map((player) =>
          player.playerId === gameState.ourState.playerId
            ? {
                ...player,
                score: player.score + pointsAwarded,
                trainsRemaining: player.trainsRemaining - route.length,
                claimedRouteIds: [...player.claimedRouteIds, route.id]
              }
            : player
        )
      },
      ourState: {
        ...gameState.ourState,
        trainsRemaining: gameState.ourState.trainsRemaining - route.length,
        hand: {
          ...gameState.ourState.hand,
          [payment.primaryColor]:
            gameState.ourState.hand[payment.primaryColor] - payment.colorCards,
          locomotive: gameState.ourState.hand.locomotive - payment.locomotives
        }
      }
    }
  };
};
