import {
  USA_BOARD,
  getBlindDrawInsight,
  recommendActions,
  recommendTurns
} from "../dist/browser.js";

self.addEventListener("message", (event) => {
  const { gameState, requestId } = event.data ?? {};

  if (!gameState) {
    self.postMessage({
      ok: false,
      requestId,
      error: "No game state provided to solver worker."
    });
    return;
  }

  try {
    const turnEvaluation = recommendTurns(gameState, USA_BOARD);
    const actionEvaluation = recommendActions(gameState, USA_BOARD);
    const blindDrawInsight = getBlindDrawInsight(gameState, USA_BOARD);

    self.postMessage({
      ok: true,
      requestId,
      turnEvaluation,
      actionEvaluation,
      blindDrawInsight
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
