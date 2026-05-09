import type {
  ExtensionId,
  PlayerId,
  RouteId,
  TicketFamily,
  TicketId,
  TrainColor
} from "./board.js";

export type TurnPhase =
  | "ready"
  | "drawing-cards"
  | "drawing-tickets"
  | "resolving-ticket-keep"
  | "finished";

export interface RulesConfig {
  extension: ExtensionId;
  playerCount: 2 | 3 | 4 | 5;
  startingTrains: number;
  faceUpSlots: 5;
  longestRouteBonus: number;
  doubleRoutesBlockedInTwoThreePlayer: boolean;
}

export interface PublicPlayerState {
  playerId: PlayerId;
  displayName: string;
  score: number;
  trainsRemaining: number;
  handCount: number;
  claimedRouteIds: RouteId[];
  ticketsDrawnCount: number;
}

export interface PrivatePlayerState {
  playerId: PlayerId;
  trainsRemaining: number;
  hand: Record<TrainColor, number>;
  ticketIds: TicketId[];
}

export interface TicketReadModel {
  family: TicketFamily;
  weight: number;
  supportingEvidence: string[];
}

export interface OpponentBeliefState {
  playerId: PlayerId;
  handColorLowerBounds: Partial<Record<TrainColor, number>>;
  handColorExpectedCounts: Partial<Record<TrainColor, number>>;
  ticketFamilyPosterior: TicketReadModel[];
  archetypePosterior: Array<{
    archetype: "builder" | "blocker" | "opportunist" | "sprinter";
    weight: number;
  }>;
  corridorInterest: Array<{
    corridorId: string;
    weight: number;
    evidence: string[];
  }>;
}

export interface PublicGameState {
  currentPlayerId: PlayerId;
  firstPlayerId: PlayerId;
  turnNumber: number;
  phase: TurnPhase;
  lastRoundTriggeredBy?: PlayerId;
  playerOrder: PlayerId[];
  players: PublicPlayerState[];
  faceUpCards: TrainColor[];
  discardCount: number;
  drawPileCount: number;
  claimedRoutes: Record<RouteId, PlayerId>;
}

export interface PendingTicketChoice {
  playerId: PlayerId;
  offeredTicketIds: TicketId[];
  minimumKeepCount: number;
}

export interface SolverAnnotations {
  activePlanTags: string[];
  securedTicketIds: TicketId[];
  atRiskTicketIds: TicketId[];
  bottleneckRouteIds: RouteId[];
  knownOutOfDeckCounts?: Partial<Record<TrainColor, number>>;
  currentTurnDrawColors?: TrainColor[];
  currentTurnDrawSources?: Array<"face-up" | "blind">;
}

export interface GameState {
  rules: RulesConfig;
  publicState: PublicGameState;
  ourState: PrivatePlayerState;
  beliefs: OpponentBeliefState[];
  pendingTicketChoice?: PendingTicketChoice;
  annotations: SolverAnnotations;
}

export const createBaseRulesConfig = (
  playerCount: 2 | 3 | 4 | 5
): RulesConfig => ({
  extension: "base-usa",
  playerCount,
  startingTrains: 45,
  faceUpSlots: 5,
  longestRouteBonus: 10,
  doubleRoutesBlockedInTwoThreePlayer: playerCount <= 3
});
