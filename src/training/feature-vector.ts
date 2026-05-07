import type { GameAction } from "../model/actions.js";
import type { ActionRecommendation, EvaluationFeatures } from "../model/evaluation.js";
import type { TrainColor } from "../model/board.js";
import type { TurnPhase } from "../model/game-state.js";
import type { TrainingCandidateActionRow } from "./types.js";

export const POLICY_FEATURE_NAMES = [
  "heuristicUtilityScore",
  "heuristicConfidence",
  "expectedFinalScore",
  "winProbabilityEstimate",
  "scoreDiffEstimate",
  "routeValue",
  "ticketValue",
  "tempoValue",
  "flexibilityValue",
  "riskCost",
  "blockExposure",
  "trainsRemainingPressure",
  "opponentClockPressure",
  "bottleneckUrgency",
  "ticketDetourPenalty",
  "playerCount",
  "knownHandSize",
  "knownLocomotiveCount",
  "knownTicketCount",
  "phaseReady",
  "phaseDrawingCards",
  "phaseDrawingTickets",
  "phaseResolvingTicketKeep",
  "actionClaimRoute",
  "actionDrawFaceUp",
  "actionDrawBlind",
  "actionDrawTickets",
  "actionKeepTickets",
  "claimUsesLocomotives",
  "claimRouteLength",
  "claimColorCards",
  "keepTicketCount",
  "drawFaceUpLocomotive",
  "drawFaceUpDemandColor",
  "knownRed",
  "knownBlue",
  "knownGreen",
  "knownYellow",
  "knownBlack",
  "knownWhite",
  "knownOrange",
  "knownPink",
  "knownLocomotive"
] as const;

export const LEARNED_POLICY_FEATURE_NAMES = POLICY_FEATURE_NAMES.filter(
  (name) =>
    name !== "phaseReady" &&
    name !== "phaseDrawingCards" &&
    name !== "phaseDrawingTickets" &&
    name !== "phaseResolvingTicketKeep"
) as readonly PolicyFeatureName[];

export type PolicyFeatureName = (typeof POLICY_FEATURE_NAMES)[number];
export type PolicyFeatureVector = Record<PolicyFeatureName, number>;

export interface PolicyFeatureContext {
  phase: TurnPhase;
  playerCount: 2 | 3 | 4 | 5;
  knownHand?: Record<TrainColor, number>;
  knownTicketCount?: number;
}

const TRAIN_COLOR_FEATURE_SUFFIX: Record<TrainColor, PolicyFeatureName> = {
  red: "knownRed",
  blue: "knownBlue",
  green: "knownGreen",
  yellow: "knownYellow",
  black: "knownBlack",
  white: "knownWhite",
  orange: "knownOrange",
  pink: "knownPink",
  locomotive: "knownLocomotive"
};

const createEmptyFeatureVector = (): PolicyFeatureVector =>
  Object.fromEntries(POLICY_FEATURE_NAMES.map((name) => [name, 0])) as PolicyFeatureVector;

const sumKnownHand = (hand?: Record<TrainColor, number>): number =>
  hand
    ? Object.values(hand).reduce((sum, count) => sum + count, 0)
    : 0;

const getActionSpecificFeatures = (
  vector: PolicyFeatureVector,
  action: GameAction,
  knownHand?: Record<TrainColor, number>
): void => {
  switch (action.kind) {
    case "claim-route":
      vector.actionClaimRoute = 1;
      vector.claimUsesLocomotives = action.payment.locomotives > 0 ? 1 : 0;
      vector.claimRouteLength = action.payment.colorCards + action.payment.locomotives;
      vector.claimColorCards = action.payment.colorCards;
      break;
    case "draw-face-up":
      vector.actionDrawFaceUp = 1;
      vector.drawFaceUpLocomotive = action.color === "locomotive" ? 1 : 0;
      vector.drawFaceUpDemandColor =
        action.color !== "locomotive" && knownHand && (knownHand[action.color] ?? 0) === 0 ? 1 : 0;
      break;
    case "draw-blind":
      vector.actionDrawBlind = 1;
      break;
    case "draw-tickets":
      vector.actionDrawTickets = 1;
      break;
    case "keep-tickets":
      vector.actionKeepTickets = 1;
      vector.keepTicketCount = action.keptTicketIds.length;
      break;
    case "refresh-face-up":
      break;
  }
};

const getPhaseFeatures = (vector: PolicyFeatureVector, phase: TurnPhase): void => {
  if (phase === "ready") {
    vector.phaseReady = 1;
  } else if (phase === "drawing-cards") {
    vector.phaseDrawingCards = 1;
  } else if (phase === "drawing-tickets") {
    vector.phaseDrawingTickets = 1;
  } else if (phase === "resolving-ticket-keep") {
    vector.phaseResolvingTicketKeep = 1;
  }
};

const applyKnownHandFeatures = (
  vector: PolicyFeatureVector,
  knownHand?: Record<TrainColor, number>
): void => {
  if (!knownHand) {
    return;
  }

  for (const [color, featureName] of Object.entries(TRAIN_COLOR_FEATURE_SUFFIX) as Array<
    [TrainColor, PolicyFeatureName]
  >) {
    vector[featureName] = knownHand[color] ?? 0;
  }

  vector.knownHandSize = sumKnownHand(knownHand);
  vector.knownLocomotiveCount = knownHand.locomotive ?? 0;
};

export const buildPolicyFeatureVector = (
  action: GameAction,
  featureBreakdown: EvaluationFeatures,
  heuristicUtilityScore: number,
  heuristicConfidence: number,
  context: PolicyFeatureContext
): PolicyFeatureVector => {
  const vector = createEmptyFeatureVector();

  vector.heuristicUtilityScore = heuristicUtilityScore;
  vector.heuristicConfidence = heuristicConfidence;
  vector.expectedFinalScore = featureBreakdown.expectedFinalScore ?? 0;
  vector.winProbabilityEstimate = featureBreakdown.winProbabilityEstimate ?? 0;
  vector.scoreDiffEstimate = featureBreakdown.scoreDiffEstimate ?? 0;
  vector.routeValue = featureBreakdown.routeValue ?? 0;
  vector.ticketValue = featureBreakdown.ticketValue ?? 0;
  vector.tempoValue = featureBreakdown.tempoValue ?? 0;
  vector.flexibilityValue = featureBreakdown.flexibilityValue ?? 0;
  vector.riskCost = featureBreakdown.riskCost ?? 0;
  vector.blockExposure = featureBreakdown.blockExposure ?? 0;
  vector.trainsRemainingPressure = featureBreakdown.trainsRemainingPressure ?? 0;
  vector.opponentClockPressure = featureBreakdown.opponentClockPressure ?? 0;
  vector.bottleneckUrgency = featureBreakdown.bottleneckUrgency ?? 0;
  vector.ticketDetourPenalty = featureBreakdown.ticketDetourPenalty ?? 0;
  vector.playerCount = context.playerCount;
  vector.knownTicketCount = context.knownTicketCount ?? 0;

  getPhaseFeatures(vector, context.phase);
  applyKnownHandFeatures(vector, context.knownHand);
  getActionSpecificFeatures(vector, action, context.knownHand);

  return vector;
};

export const buildPolicyFeatureVectorFromRow = (
  row: TrainingCandidateActionRow
): PolicyFeatureVector =>
  buildPolicyFeatureVector(
    row.candidateAction,
    row.featureBreakdown,
    row.heuristicUtilityScore,
    row.heuristicConfidence,
    {
      phase: row.phase,
      playerCount: row.playerCount,
      knownHand: row.knownHand,
      knownTicketCount: row.knownTicketIds.length
    }
  );

export const buildPolicyFeatureVectorFromRecommendation = (
  recommendation: ActionRecommendation,
  context: PolicyFeatureContext
): PolicyFeatureVector =>
  buildPolicyFeatureVector(
    recommendation.action,
    recommendation.featureBreakdown,
    recommendation.utilityScore,
    recommendation.confidence,
    context
  );

export const vectorToArray = (vector: PolicyFeatureVector): number[] =>
  POLICY_FEATURE_NAMES.map((name) => vector[name]);

export const vectorToFeatureArray = (
  vector: PolicyFeatureVector,
  featureNames: readonly PolicyFeatureName[]
): number[] => featureNames.map((name) => vector[name]);
