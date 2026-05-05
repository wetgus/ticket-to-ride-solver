import type { ClaimRouteAction, ClaimRoutePayment } from "../model/actions.js";
import type { RouteDefinition, TrainColor } from "../model/board.js";
import type { GameState, PrivatePlayerState } from "../model/game-state.js";
import { canClaimRoute } from "./claiming.js";

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

const getColorRoutePayments = (
  hand: PrivatePlayerState["hand"],
  route: RouteDefinition
): ClaimRoutePayment[] => {
  if (route.color === "gray") {
    return [];
  }

  const payments: ClaimRoutePayment[] = [];
  const colorCardsAvailable = hand[route.color] ?? 0;
  const locomotivesAvailable = hand.locomotive ?? 0;
  const minimumColorCards = Math.max(0, route.length - locomotivesAvailable);
  const maximumColorCards = Math.min(route.length, colorCardsAvailable);

  for (let colorCards = maximumColorCards; colorCards >= minimumColorCards; colorCards -= 1) {
    payments.push({
      primaryColor: route.color,
      colorCards,
      locomotives: route.length - colorCards
    });
  }

  return payments;
};

const getGrayRoutePayments = (
  hand: PrivatePlayerState["hand"],
  route: RouteDefinition
): ClaimRoutePayment[] => {
  if (route.color !== "gray") {
    return [];
  }

  const payments: ClaimRoutePayment[] = [];
  const locomotivesAvailable = hand.locomotive ?? 0;

  for (const color of NON_WILD_COLORS) {
    const colorCardsAvailable = hand[color] ?? 0;
    const minimumColorCards = Math.max(0, route.length - locomotivesAvailable);
    const maximumColorCards = Math.min(route.length, colorCardsAvailable);

    for (let colorCards = maximumColorCards; colorCards >= minimumColorCards; colorCards -= 1) {
      payments.push({
        primaryColor: color,
        colorCards,
        locomotives: route.length - colorCards
      });
    }
  }

  return payments;
};

const deduplicatePayments = (
  payments: ClaimRoutePayment[]
): ClaimRoutePayment[] => {
  const unique = new Map<string, ClaimRoutePayment>();

  for (const currentPayment of payments) {
    const key =
      currentPayment.colorCards === 0
        ? `loco-only:${currentPayment.locomotives}`
        : `${currentPayment.primaryColor}:${currentPayment.colorCards}:${currentPayment.locomotives}`;

    if (!unique.has(key)) {
      unique.set(key, currentPayment);
    }
  }

  return [...unique.values()];
};

export const getCandidateClaimPayments = (
  hand: PrivatePlayerState["hand"],
  route: RouteDefinition
): ClaimRoutePayment[] =>
  deduplicatePayments(
    route.color === "gray"
      ? getGrayRoutePayments(hand, route)
      : getColorRoutePayments(hand, route)
  );

export const getLegalClaimRouteActions = (
  gameState: GameState,
  routes: RouteDefinition[],
  routesByParallelGroup: Map<string, RouteDefinition[]>
): ClaimRouteAction[] => {
  if (
    gameState.publicState.currentPlayerId !== gameState.ourState.playerId ||
    gameState.publicState.phase !== "ready"
  ) {
    return [];
  }

  const actions: ClaimRouteAction[] = [];

  for (const currentRoute of routes) {
    for (const payment of getCandidateClaimPayments(gameState.ourState.hand, currentRoute)) {
      const claimCheck = canClaimRoute(
        gameState,
        gameState.ourState.playerId,
        currentRoute,
        payment,
        routesByParallelGroup
      );

      if (!claimCheck.ok) {
        continue;
      }

      actions.push({
        kind: "claim-route",
        playerId: gameState.ourState.playerId,
        routeId: currentRoute.id,
        payment
      });
    }
  }

  return actions;
};
