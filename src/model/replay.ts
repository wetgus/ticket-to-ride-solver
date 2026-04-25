import type { GameAction } from "./actions.js";
import type { ExtensionId, PlayerId } from "./board.js";

export interface ReplayPlayer {
  playerId: PlayerId;
  displayName: string;
  seatIndex: number;
}

export interface ReplayMetadata {
  source: "manual" | "boardgamearena" | "other";
  recordedAtIso?: string;
  notes?: string;
}

export interface ReplayGameHeader {
  mapId: "usa";
  extension: ExtensionId;
  playerCount: 2 | 3 | 4 | 5;
  players: ReplayPlayer[];
}

export interface ReplayTurn {
  turnNumber: number;
  actorId: PlayerId;
  actions: GameAction[];
  publicNotes?: string[];
}

export interface ReplayGame {
  header: ReplayGameHeader;
  metadata?: ReplayMetadata;
  turns: ReplayTurn[];
}
