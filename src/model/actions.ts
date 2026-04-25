import type { PlayerId, RouteId, TicketId, TrainColor } from "./board.js";

export interface PaymentCardSet {
  color: TrainColor;
  count: number;
}

export interface ClaimRoutePayment {
  primaryColor: Exclude<TrainColor, "locomotive">;
  colorCards: number;
  locomotives: number;
}

export interface DrawFaceUpAction {
  kind: "draw-face-up";
  playerId: PlayerId;
  color: TrainColor;
  drawIndex: 1 | 2;
}

export interface DrawBlindAction {
  kind: "draw-blind";
  playerId: PlayerId;
  drawIndex: 1 | 2;
}

export interface ClaimRouteAction {
  kind: "claim-route";
  playerId: PlayerId;
  routeId: RouteId;
  payment: ClaimRoutePayment;
}

export interface DrawTicketsAction {
  kind: "draw-tickets";
  playerId: PlayerId;
  offeredTicketIds: TicketId[];
}

export interface KeepTicketsAction {
  kind: "keep-tickets";
  playerId: PlayerId;
  keptTicketIds: TicketId[];
  rejectedTicketIds: TicketId[];
}

export interface FaceUpRefreshAction {
  kind: "refresh-face-up";
  faceUpCards: TrainColor[];
}

export type GameAction =
  | DrawFaceUpAction
  | DrawBlindAction
  | ClaimRouteAction
  | DrawTicketsAction
  | KeepTicketsAction
  | FaceUpRefreshAction;
