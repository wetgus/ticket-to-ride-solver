import fs from "node:fs";
import path from "node:path";
import { USA_BOARD } from "../data/usa-board.js";
import { parseBgaLog } from "../replay/bga-log-parser.js";
import {
  inferReplayGameVariant,
  loadDestinationMetadata
} from "../replay/destination-metadata.js";
import { extractDecisionSnapshots } from "../replay/reconstruction.js";

const logPath = process.argv[2];
const selfPlayerName = process.argv[3];
const metadataPath = process.argv[4];

if (!logPath || !selfPlayerName) {
  process.stderr.write(
    "Usage: node dist/scripts/export-decision-dataset.js <path-to-log.txt> <self-player-name>\n"
  );
  process.exit(1);
}

const absoluteLogPath = path.resolve(logPath);
const rawText = fs.readFileSync(absoluteLogPath, "utf8");
const parsedReplay = parseBgaLog(rawText, { selfPlayerName });
const metadata = metadataPath ? loadDestinationMetadata(metadataPath) : undefined;
const gameVariant = metadata
  ? inferReplayGameVariant(metadata)
  : "usa-base";
const decisions = extractDecisionSnapshots(
  parsedReplay,
  USA_BOARD,
  selfPlayerName,
  metadata
);

const artifactsDir = path.resolve("artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });

const baseName = path.basename(logPath, path.extname(logPath));
const slug = `${baseName}-${selfPlayerName}`;
const jsonlPath = path.join(artifactsDir, `${slug}.decision-dataset.jsonl`);
const csvPath = path.join(artifactsDir, `${slug}.decision-dataset.csv`);
const summaryPath = path.join(artifactsDir, `${slug}.decision-summary.json`);

const rows = decisions.map((decision) => ({
  gameVariant,
  moveNumber: decision.moveNumber,
  timestamp: decision.timestamp,
  playerName: decision.playerName,
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
  destinationSelectionAppliedKept: decision.destinationSelectionApplied?.kept.join(" | ") ?? ""
}));

fs.writeFileSync(
  jsonlPath,
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  "utf8"
);

const csvHeaders = Object.keys(rows[0] ?? {
  moveNumber: "",
  timestamp: "",
  playerName: "",
  chosenActionKind: "",
  chosenRouteId: "",
  chosenCardCodes: "",
  drawCount: "",
  currentScore: "",
  trainsRemaining: "",
  knownHandSize: "",
  knownColorDiversity: "",
  visibleDrawCountSoFar: "",
  hiddenDrawCountSoFar: "",
  claimedRouteCount: "",
  currentLongestRouteLength: "",
  legalClaimCount: "",
  maxLegalClaimLength: "",
  maxLegalClaimPoints: "",
  availableSixLengthClaims: "",
  availableLocomotiveClaims: "",
  completedDestinationCountSoFar: ""
  ,
  knownDestinations: "",
  knownDestinationCount: "",
  destinationSelectionAppliedKept: ""
});

const escapeCsv = (value: string | number): string => {
  const stringValue = String(value);
  return /[",\n]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, "\"\"")}"`
    : stringValue;
};

const csvLines = [
  csvHeaders.join(","),
  ...rows.map((row) => csvHeaders.map((header) => escapeCsv(row[header as keyof typeof row] ?? "")).join(","))
];

fs.writeFileSync(csvPath, `${csvLines.join("\n")}\n`, "utf8");

const claimDecisions = rows.filter((row) => row.chosenActionKind === "claim-route");
const drawVisibleDecisions = rows.filter((row) => row.chosenActionKind === "draw-visible");
const drawHiddenDecisions = rows.filter((row) => row.chosenActionKind === "draw-hidden");
const keepDestinationDecisions = rows.filter((row) => row.chosenActionKind === "keep-destinations");

const summary = {
  logPath: absoluteLogPath,
  playerName: selfPlayerName,
  gameVariant,
  decisionCount: rows.length,
  claimDecisionCount: claimDecisions.length,
  drawVisibleDecisionCount: drawVisibleDecisions.length,
  drawHiddenDecisionCount: drawHiddenDecisions.length,
  keepDestinationDecisionCount: keepDestinationDecisions.length,
  averageLegalClaimCount:
    rows.reduce((sum, row) => sum + Number(row.legalClaimCount), 0) / Math.max(rows.length, 1),
  averageKnownHandSize:
    rows.reduce((sum, row) => sum + Number(row.knownHandSize), 0) / Math.max(rows.length, 1),
  claimWhenSixLengthAvailableCount: claimDecisions.filter(
    (row) => Number(row.availableSixLengthClaims) > 0
  ).length,
  drawWhenSixLengthAvailableCount: [...drawVisibleDecisions, ...drawHiddenDecisions].filter(
    (row) => Number(row.availableSixLengthClaims) > 0
  ).length,
  claimWhenCompletedTicketsGrewCount: claimDecisions.filter(
    (row) => Number(row.completedDestinationCountSoFar) > 0
  ).length,
  decisionsWithKnownDestinations: rows.filter(
    (row) => Number(row.knownDestinationCount) > 0
  ).length,
  maxObservedLongestRouteLength: rows.reduce(
    (maxValue, row) => Math.max(maxValue, Number(row.currentLongestRouteLength)),
    0
  )
};

fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

process.stdout.write(`Exported decision dataset for ${selfPlayerName}\n`);
process.stdout.write(`- JSONL: ${jsonlPath}\n`);
process.stdout.write(`- CSV: ${csvPath}\n`);
process.stdout.write(`- Summary: ${summaryPath}\n`);
