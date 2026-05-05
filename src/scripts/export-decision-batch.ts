import fs from "node:fs";
import path from "node:path";
import { USA_BOARD } from "../data/usa-board.js";
import {
  inferReplayGameVariant,
  loadDestinationMetadata,
  type ReplayGameVariant
} from "../replay/destination-metadata.js";
import { parseBgaLog } from "../replay/bga-log-parser.js";
import { extractDecisionSnapshots } from "../replay/reconstruction.js";

interface BatchRow {
  gameId: string;
  gameVariant: ReplayGameVariant;
  logPath: string;
  playerName: string;
  moveNumber: number;
  timestamp: string;
  chosenActionKind: string;
  chosenRouteId: string;
  chosenCardCodes: string;
  drawCount: string | number;
  currentScore: number;
  trainsRemaining: number;
  knownHandSize: number;
  knownColorDiversity: number;
  visibleDrawCountSoFar: number;
  hiddenDrawCountSoFar: number;
  claimedRouteCount: number;
  currentLongestRouteLength: number;
  legalClaimCount: number;
  maxLegalClaimLength: number;
  maxLegalClaimPoints: number;
  availableSixLengthClaims: number;
  availableLocomotiveClaims: number;
  completedDestinationCountSoFar: number;
  knownDestinations: string;
  knownDestinationCount: number;
  destinationSelectionAppliedKept: string;
}

interface PlayerSummaryRow {
  gameId: string;
  gameVariant: ReplayGameVariant;
  playerName: string;
  decisionCount: number;
  claimDecisionCount: number;
  drawDecisionCount: number;
  averageLegalClaimCount: number;
  decisionsWithKnownDestinations: number;
  claimWhenSixLengthAvailableCount: number;
  drawWhenSixLengthAvailableCount: number;
  maxObservedLongestRouteLength: number;
}

const logsDir = path.resolve("logs");
const artifactsDir = path.resolve("artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });

const logFiles = fs
  .readdirSync(logsDir)
  .filter((fileName) => fileName.endsWith(".txt") && !fileName.endsWith(".metadata.json"));

const metadataFiles = new Set(
  fs.readdirSync(logsDir).filter((fileName) => fileName.endsWith(".metadata.json"))
);

const allRows: BatchRow[] = [];
const playerSummaries: PlayerSummaryRow[] = [];

for (const logFile of logFiles) {
  const baseName = path.basename(logFile, ".txt");
  const metadataFileName = `${baseName}.metadata.json`;

  if (!metadataFiles.has(metadataFileName)) {
    continue;
  }

  const absoluteLogPath = path.join(logsDir, logFile);
  const absoluteMetadataPath = path.join(logsDir, metadataFileName);
  const rawText = fs.readFileSync(absoluteLogPath, "utf8");
  const metadata = loadDestinationMetadata(absoluteMetadataPath);
  const gameVariant = inferReplayGameVariant(metadata);

  for (const player of metadata.players) {
    const parsedReplay = parseBgaLog(rawText, { selfPlayerName: player.playerName });
    const decisions = extractDecisionSnapshots(
      parsedReplay,
      USA_BOARD,
      player.playerName,
      metadata
    );

    const rows: BatchRow[] = decisions.map((decision) => ({
      gameId: metadata.gameId,
      gameVariant,
      logPath: absoluteLogPath,
      playerName: player.playerName,
      moveNumber: decision.moveNumber,
      timestamp: decision.timestamp,
      chosenActionKind: decision.chosenAction.kind,
      chosenRouteId: decision.chosenAction.routeId ?? "",
      chosenCardCodes: (decision.chosenAction.cardCodes ?? []).join(","),
      drawCount: decision.chosenAction.drawCount ?? "",
      currentScore: decision.features.currentScore,
      trainsRemaining: decision.features.trainsRemaining,
      knownHandSize: decision.features.knownHandSize,
      knownColorDiversity: decision.features.knownColorDiversity,
      visibleDrawCountSoFar: decision.features.visibleDrawCountSoFar,
      hiddenDrawCountSoFar: decision.features.hiddenDrawCountSoFar,
      claimedRouteCount: decision.features.claimedRouteCount,
      currentLongestRouteLength: decision.features.currentLongestRouteLength,
      legalClaimCount: decision.features.legalClaimCount,
      maxLegalClaimLength: decision.features.maxLegalClaimLength,
      maxLegalClaimPoints: decision.features.maxLegalClaimPoints,
      availableSixLengthClaims: decision.features.availableSixLengthClaims,
      availableLocomotiveClaims: decision.features.availableLocomotiveClaims,
      completedDestinationCountSoFar: decision.features.completedDestinationCountSoFar,
      knownDestinations: decision.knownDestinations.join(" | "),
      knownDestinationCount: decision.knownDestinations.length,
      destinationSelectionAppliedKept:
        decision.destinationSelectionApplied?.kept.join(" | ") ?? ""
    }));

    allRows.push(...rows);

    const claimRows = rows.filter((row) => row.chosenActionKind === "claim-route");
    const drawRows = rows.filter(
      (row) =>
        row.chosenActionKind === "draw-visible" ||
        row.chosenActionKind === "draw-hidden"
    );

    playerSummaries.push({
      gameId: metadata.gameId,
      gameVariant,
      playerName: player.playerName,
      decisionCount: rows.length,
      claimDecisionCount: claimRows.length,
      drawDecisionCount: drawRows.length,
      averageLegalClaimCount:
        rows.reduce((sum, row) => sum + row.legalClaimCount, 0) / Math.max(rows.length, 1),
      decisionsWithKnownDestinations: rows.filter((row) => row.knownDestinationCount > 0).length,
      claimWhenSixLengthAvailableCount: claimRows.filter(
        (row) => row.availableSixLengthClaims > 0
      ).length,
      drawWhenSixLengthAvailableCount: drawRows.filter(
        (row) => row.availableSixLengthClaims > 0
      ).length,
      maxObservedLongestRouteLength: rows.reduce(
        (maxValue, row) => Math.max(maxValue, row.currentLongestRouteLength),
        0
      )
    });
  }
}

const escapeCsv = (value: string | number): string => {
  const stringValue = String(value);
  return /[",\n]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, "\"\"")}"`
    : stringValue;
};

const writeCsv = <T extends object>(targetPath: string, rows: T[]): void => {
  const headers = Object.keys(rows[0] ?? {});
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => escapeCsv((row as Record<string, string | number>)[header] ?? ""))
        .join(",")
    )
  ];
  fs.writeFileSync(targetPath, `${lines.join("\n")}\n`, "utf8");
};

const writeJsonl = (targetPath: string, rows: BatchRow[]): void => {
  fs.writeFileSync(
    targetPath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""),
    "utf8"
  );
};

const summarizeCorpus = (
  rows: BatchRow[],
  summaries: PlayerSummaryRow[]
): Record<string, number | string | string[]> => ({
  variantsIncluded: [...new Set(rows.map((row) => row.gameVariant))],
  totalRows: rows.length,
  totalGames: [...new Set(summaries.map((summary) => summary.gameId))].length,
  totalPlayers: [...new Set(summaries.map((summary) => `${summary.gameId}:${summary.playerName}`))]
    .length,
  totalClaimDecisions: rows.filter((row) => row.chosenActionKind === "claim-route").length,
  totalDrawVisibleDecisions: rows.filter((row) => row.chosenActionKind === "draw-visible").length,
  totalDrawHiddenDecisions: rows.filter((row) => row.chosenActionKind === "draw-hidden").length,
  rowsWithKnownDestinations: rows.filter((row) => row.knownDestinationCount > 0).length,
  averageLegalClaimCount:
    rows.reduce((sum, row) => sum + row.legalClaimCount, 0) / Math.max(rows.length, 1)
});

const writeCorpusBundle = (
  prefix: string,
  rows: BatchRow[],
  summaries: PlayerSummaryRow[]
): void => {
  writeJsonl(path.join(artifactsDir, `${prefix}.jsonl`), rows);
  writeCsv(path.join(artifactsDir, `${prefix}.csv`), rows);
  writeCsv(path.join(artifactsDir, `${prefix}-per-player.csv`), summaries);
  fs.writeFileSync(
    path.join(artifactsDir, `${prefix}-summary.json`),
    `${JSON.stringify(summarizeCorpus(rows, summaries), null, 2)}\n`,
    "utf8"
  );
};

const baseRows = allRows.filter((row) => row.gameVariant === "usa-base");
const megaRows = allRows.filter((row) => row.gameVariant === "usa-1910-mega");
const unknownRows = allRows.filter((row) => row.gameVariant === "unknown");

const baseSummaries = playerSummaries.filter((summary) => summary.gameVariant === "usa-base");
const megaSummaries = playerSummaries.filter((summary) => summary.gameVariant === "usa-1910-mega");
const unknownSummaries = playerSummaries.filter((summary) => summary.gameVariant === "unknown");

writeCorpusBundle("decision-corpus", baseRows, baseSummaries);
writeCorpusBundle("decision-corpus-all", allRows, playerSummaries);

if (megaRows.length > 0) {
  writeCorpusBundle("decision-corpus-usa-1910-mega", megaRows, megaSummaries);
}

if (unknownRows.length > 0) {
  writeCorpusBundle("decision-corpus-unknown", unknownRows, unknownSummaries);
}

process.stdout.write("Exported decision corpus artifacts\n");
process.stdout.write(`- Base USA rows: ${baseRows.length}\n`);
process.stdout.write(`- 1910 Mega rows: ${megaRows.length}\n`);
process.stdout.write(`- All rows: ${allRows.length}\n`);
process.stdout.write(`- Base summary: ${path.join(artifactsDir, "decision-corpus-summary.json")}\n`);
process.stdout.write(
  `- All-variants summary: ${path.join(artifactsDir, "decision-corpus-all-summary.json")}\n`
);
