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
}

export interface ActionRecommendation {
  actionId: string;
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
