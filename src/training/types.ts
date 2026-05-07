import type { GameAction } from "../model/actions.js";
import type { ExtensionId, PlayerId, TicketId, TrainColor } from "../model/board.js";
import type { EvaluationFeatures } from "../model/evaluation.js";
import type { TurnPhase } from "../model/game-state.js";

export interface TrainingCandidateActionRow {
  gameId: string;
  turnIndex: number;
  playerId: PlayerId;
  playerCount: 2 | 3 | 4 | 5;
  variant: ExtensionId;
  phase: TurnPhase;
  seatIndex: number;
  candidateActionId: string;
  candidateAction: GameAction;
  heuristicUtilityScore: number;
  heuristicConfidence: number;
  heuristicTopRationale: string[];
  featureBreakdown: EvaluationFeatures;
  wasChosen: boolean;
  knownHand: Record<TrainColor, number>;
  knownTicketIds: TicketId[];
  finalScore?: number;
  finalPlace?: number;
  wonGame?: boolean;
  longestRouteWon?: boolean;
  completedTicketCount?: number;
}

export interface CompletedGameOutcome {
  gameId: string;
  playerId: PlayerId;
  finalScore: number;
  finalPlace: number;
  wonGame: boolean;
  longestRouteWon: boolean;
  completedTicketIds: TicketId[];
  failedTicketIds: TicketId[];
}

export interface SelfPlayTraceStep {
  gameId: string;
  turnIndex: number;
  activePlayerId: PlayerId;
  phase: TurnPhase;
  chosenAction: GameAction;
  candidateRows: TrainingCandidateActionRow[];
}

export interface BenchmarkMatchSummary {
  matchupId: string;
  gameCount: number;
  trackedAgentId: string;
  winRate: number;
  averagePlacement: number;
  averageScore: number;
  averageCompletedTicketCount: number;
  longestRouteRate: number;
}

export interface PolicyTrainingBatchManifest {
  batchId: string;
  createdAtIso: string;
  sourceKinds: Array<"replay" | "self-play" | "cross-play">;
  gameIds: string[];
  rowCount: number;
  notes: string[];
}
