import type { TrainingCandidateActionRow } from "./types.js";

export const computeTrainingTarget = (row: TrainingCandidateActionRow): number => {
  const finalScore = row.finalScore ?? 0;
  const finalPlace = row.finalPlace ?? row.playerCount;
  const placeReward = (row.playerCount - finalPlace) * 15;
  const ticketReward = (row.completedTicketCount ?? 0) * 4;
  const longestRouteReward = row.longestRouteWon ? 6 : 0;
  const winReward = row.wonGame ? 25 : 0;

  return finalScore + placeReward + ticketReward + longestRouteReward + winReward;
};
