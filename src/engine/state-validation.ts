import { TRAIN_COLORS, type PlayerId, type RouteDefinition } from "../model/board.js";
import type { GameState, PublicPlayerState } from "../model/game-state.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

const getPublicPlayer = (
  players: PublicPlayerState[],
  playerId: PlayerId
): PublicPlayerState | undefined =>
  players.find((player) => player.playerId === playerId);

const validateTrainColorCounts = (gameState: GameState): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  for (const color of TRAIN_COLORS) {
    const count = gameState.ourState.hand[color];

    if (!Number.isInteger(count) || count < 0) {
      issues.push({
        severity: "error",
        message: `Invalid hand count for color ${color}: ${count}`
      });
    }
  }

  return issues;
};

const validatePlayerConsistency = (gameState: GameState): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const publicPlayer = getPublicPlayer(
    gameState.publicState.players,
    gameState.ourState.playerId
  );

  if (!publicPlayer) {
    issues.push({
      severity: "error",
      message: "Our player is missing from publicState.players."
    });
    return issues;
  }

  if (publicPlayer.trainsRemaining !== gameState.ourState.trainsRemaining) {
    issues.push({
      severity: "error",
      message:
        "Public/private trainsRemaining mismatch for our player."
    });
  }

  if (gameState.publicState.currentPlayerId !== gameState.ourState.playerId) {
    issues.push({
      severity: "warning",
      message:
        "Current state is not on our turn; some local helpers may return empty legal actions."
    });
  }

  return issues;
};

const validateClaimedRoutes = (
  gameState: GameState,
  routesById: Map<string, RouteDefinition>
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  for (const [routeId, ownerId] of Object.entries(gameState.publicState.claimedRoutes)) {
    if (!routesById.has(routeId)) {
      issues.push({
        severity: "error",
        message: `Claimed route references unknown route id: ${routeId}`
      });
    }

    if (!getPublicPlayer(gameState.publicState.players, ownerId)) {
      issues.push({
        severity: "error",
        message: `Claimed route ${routeId} references unknown player id: ${ownerId}`
      });
    }
  }

  return issues;
};

const validatePlayerOrder = (gameState: GameState): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const playerIds = new Set(gameState.publicState.players.map((player) => player.playerId));

  if (playerIds.size !== gameState.publicState.players.length) {
    issues.push({
      severity: "error",
      message: "Duplicate player ids in publicState.players."
    });
  }

  if (gameState.publicState.playerOrder.length !== gameState.publicState.players.length) {
    issues.push({
      severity: "error",
      message: "playerOrder length does not match number of players."
    });
  }

  for (const currentPlayerId of gameState.publicState.playerOrder) {
    if (!playerIds.has(currentPlayerId)) {
      issues.push({
        severity: "error",
        message: `playerOrder references unknown player id: ${currentPlayerId}`
      });
    }
  }

  return issues;
};

export const validateGameState = (
  gameState: GameState,
  routesById: Map<string, RouteDefinition>
): ValidationIssue[] => [
  ...validateTrainColorCounts(gameState),
  ...validatePlayerConsistency(gameState),
  ...validateClaimedRoutes(gameState, routesById),
  ...validatePlayerOrder(gameState)
];
