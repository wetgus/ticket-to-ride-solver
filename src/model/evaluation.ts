import type { GameAction } from "./actions.js";
import type { RouteId, TicketId } from "./board.js";

export interface TicketCompletionEstimate {
  ticketId: TicketId;
  completionProbability: number;
  expectedValue: number;
  trainsRequiredLowerBound: number;
  viablePathCount: number;
  bottleneckRouteIds: RouteId[];
}

export interface RouteUrgencyEstimate {
  routeId: RouteId;
  loseBeforeNextTurnProbability: number;
  supportingSignals: string[];
}

export interface EvaluationFeatures {
  expectedFinalScore: number;
  winProbabilityEstimate: number;
  scoreDiffEstimate: number;
  routeValue: number;
  ticketValue: number;
  tempoValue: number;
  flexibilityValue: number;
  riskCost: number;
  blockExposure: number;
  trainsRemainingPressure: number;
  opponentClockPressure: number;
  bottleneckUrgency: number;
  ticketDetourPenalty: number;
}

export interface ActionRecommendation {
  action: GameAction;
  actionId: string;
  utilityScore: number;
  confidence: number;
  rationale: string[];
  featureBreakdown: EvaluationFeatures;
}

export interface TurnRecommendation {
  turnId: string;
  actions: GameAction[];
  utilityScore: number;
  confidence: number;
  rationale: string[];
  featureBreakdown: EvaluationFeatures;
}

export interface PositionEvaluation {
  topRecommendation?: ActionRecommendation;
  alternatives: ActionRecommendation[];
  ticketEstimates: TicketCompletionEstimate[];
  routeUrgency: RouteUrgencyEstimate[];
}

export interface TurnEvaluation {
  topRecommendation?: TurnRecommendation;
  alternatives: TurnRecommendation[];
  ticketEstimates: TicketCompletionEstimate[];
  routeUrgency: RouteUrgencyEstimate[];
}
