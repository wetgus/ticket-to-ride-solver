import fs from "node:fs";
import path from "node:path";

export interface DestinationSelectionMetadata {
  selectionType: "initial" | "midgame-draw";
  moveNumber?: number;
  offered?: string[];
  kept: string[];
}

export type ReplayGameVariant = "usa-base" | "usa-1910-mega" | "unknown";

export interface PlayerDestinationMetadata {
  playerName: string;
  destinationSelections: DestinationSelectionMetadata[];
}

export interface ReplayDestinationMetadata {
  gameId: string;
  sourceLog: string;
  gameVariant?: ReplayGameVariant;
  players: PlayerDestinationMetadata[];
}

export const loadDestinationMetadata = (
  metadataPath: string
): ReplayDestinationMetadata => {
  const absolutePath = path.resolve(metadataPath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as ReplayDestinationMetadata;
};

export const inferReplayGameVariant = (
  metadata: Pick<ReplayDestinationMetadata, "gameId" | "sourceLog" | "gameVariant">
): ReplayGameVariant => {
  if (metadata.gameVariant) {
    return metadata.gameVariant;
  }

  const variantHint = `${metadata.gameId} ${metadata.sourceLog}`.toLowerCase();

  if (variantHint.includes("1910 mega")) {
    return "usa-1910-mega";
  }

  if (variantHint.includes("table-")) {
    return "usa-base";
  }

  return "unknown";
};

export const getPlayerDestinationMetadata = (
  metadata: ReplayDestinationMetadata,
  playerName: string
): PlayerDestinationMetadata | undefined =>
  metadata.players.find((player) => player.playerName === playerName);

export const getKnownKeptDestinationsBeforeMove = (
  metadata: ReplayDestinationMetadata,
  playerName: string,
  moveNumber: number
): string[] => {
  const player = getPlayerDestinationMetadata(metadata, playerName);

  if (!player) {
    return [];
  }

  const keptDestinations: string[] = [];

  for (const selection of player.destinationSelections) {
    if (
      selection.selectionType === "initial" ||
      (selection.selectionType === "midgame-draw" &&
        selection.moveNumber !== undefined &&
        selection.moveNumber < moveNumber)
    ) {
      keptDestinations.push(...selection.kept);
    }
  }

  return keptDestinations;
};

export const getSelectionAppliedAtMove = (
  metadata: ReplayDestinationMetadata,
  playerName: string,
  moveNumber: number
): DestinationSelectionMetadata | undefined => {
  const player = getPlayerDestinationMetadata(metadata, playerName);

  if (!player) {
    return undefined;
  }

  return player.destinationSelections.find(
    (selection) =>
      selection.selectionType === "midgame-draw" && selection.moveNumber === moveNumber
  );
};
