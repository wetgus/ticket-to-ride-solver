import type { ClaimRouteAction, GameAction } from "../model/actions.js";
import type { RouteDefinition } from "../model/board.js";
import type { GameState } from "../model/game-state.js";
import { canClaimRoute, applyOwnRouteClaim } from "./claiming.js";
import { advanceToNextPlayer } from "./turns.js";

export interface ApplyActionSuccess {
  ok: true;
  updatedState: GameState;
  notes: string[];
}

export interface ApplyActionFailure {
  ok: false;
  reason: string;
}

export type ApplyActionResult = ApplyActionSuccess | ApplyActionFailure;

const applyClaimRouteAction = (
  gameState: GameState,
  action: ClaimRouteAction,
  routesById: Map<string, RouteDefinition>,
  routesByParallelGroup: Map<string, RouteDefinition[]>
): ApplyActionResult => {
  const route = routesById.get(action.routeId);

  if (!route) {
    return { ok: false, reason: `Unknown route id: ${action.routeId}` };
  }

  const claimCheck = canClaimRoute(
    gameState,
    action.playerId,
    route,
    action.payment,
    routesByParallelGroup
  );

  if (!claimCheck.ok) {
    return { ok: false, reason: claimCheck.reason ?? "Illegal route claim." };
  }

  const claimedState = applyOwnRouteClaim(gameState, route, action.payment);
  const updatedState = advanceToNextPlayer(claimedState.updatedState);

  return {
    ok: true,
    updatedState,
    notes: [
      `Claimed route ${route.cityA} - ${route.cityB} for ${claimedState.pointsAwarded} points.`,
      updatedState.publicState.lastRoundTriggeredBy
        ? `Last round has been triggered by ${updatedState.publicState.lastRoundTriggeredBy}.`
        : "Game continues in normal phase."
    ]
  };
};

export const applyAction = (
  gameState: GameState,
  action: GameAction,
  routesById: Map<string, RouteDefinition>,
  routesByParallelGroup: Map<string, RouteDefinition[]>
): ApplyActionResult => {
  switch (action.kind) {
    case "claim-route":
      return applyClaimRouteAction(
        gameState,
        action,
        routesById,
        routesByParallelGroup
      );
    default:
      return {
        ok: false,
        reason: `Action kind not implemented yet: ${action.kind}`
      };
  }
};
