import type { GameState } from "../model/game-state.js";

export const shouldTriggerLastRound = (gameState: GameState): boolean =>
  gameState.publicState.players.some((player) => player.trainsRemaining <= 2);

export const advanceToNextPlayer = (gameState: GameState): GameState => {
  const currentIndex = gameState.publicState.playerOrder.indexOf(
    gameState.publicState.currentPlayerId
  );
  const nextIndex = (currentIndex + 1) % gameState.publicState.playerOrder.length;
  const nextPlayerId = gameState.publicState.playerOrder[nextIndex];
  const lastRoundTriggeredBy =
    gameState.publicState.lastRoundTriggeredBy ??
    (shouldTriggerLastRound(gameState) ? gameState.publicState.currentPlayerId : undefined);
  const lastRoundPatch = lastRoundTriggeredBy
    ? { lastRoundTriggeredBy }
    : {};

  return {
    ...gameState,
    publicState: {
      ...gameState.publicState,
      currentPlayerId: nextPlayerId,
      turnNumber:
        nextIndex === 0
          ? gameState.publicState.turnNumber + 1
          : gameState.publicState.turnNumber,
      phase: "ready",
      ...lastRoundPatch
    }
  };
};
