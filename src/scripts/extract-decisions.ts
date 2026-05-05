import fs from "node:fs";
import path from "node:path";
import { USA_BOARD } from "../data/usa-board.js";
import { parseBgaLog } from "../replay/bga-log-parser.js";
import { loadDestinationMetadata } from "../replay/destination-metadata.js";
import { extractDecisionSnapshots } from "../replay/reconstruction.js";

const logPath = process.argv[2];
const selfPlayerName = process.argv[3];
const metadataPath = process.argv[4];

if (!logPath || !selfPlayerName) {
  process.stderr.write(
    "Usage: node dist/scripts/extract-decisions.js <path-to-log.txt> <self-player-name>\n"
  );
  process.exit(1);
}

const absolutePath = path.resolve(logPath);
const rawText = fs.readFileSync(absolutePath, "utf8");
const parsedReplay = parseBgaLog(rawText, { selfPlayerName });
const metadata = metadataPath ? loadDestinationMetadata(metadataPath) : undefined;
const decisions = extractDecisionSnapshots(
  parsedReplay,
  USA_BOARD,
  selfPlayerName,
  metadata
);

process.stdout.write(`Decision snapshots: ${absolutePath}\n`);
process.stdout.write(`Player: ${selfPlayerName}\n`);
process.stdout.write(`Count: ${decisions.length}\n\n`);

for (const decision of decisions) {
  const knownHand = decision.preMoveSnapshot.selfKnownState?.exactKnownCards;
  const handSummary = knownHand
    ? Object.entries(knownHand)
        .filter(([, count]) => count > 0)
        .map(([color, count]) => `${color}:${count}`)
        .join(", ")
    : "unknown";

  process.stdout.write(
    `- Move ${decision.moveNumber} @ ${decision.timestamp} | chosen=${decision.chosenAction.kind} | legalClaims=${decision.legalClaimActions.length} | maxClaimLen=${decision.features.maxLegalClaimLength} | maxClaimPts=${decision.features.maxLegalClaimPoints} | longestRoute=${decision.features.currentLongestRouteLength} | completedTickets=${decision.features.completedDestinationCountSoFar} | destinations=${decision.knownDestinations.length} | knownHand=[${handSummary || "empty"}]\n`
  );

  if (decision.chosenAction.kind === "claim-route" && decision.chosenAction.routeId) {
    process.stdout.write(`  route=${decision.chosenAction.routeId}\n`);
  }

  if (
    (decision.chosenAction.kind === "draw-visible" ||
      decision.chosenAction.kind === "draw-hidden") &&
    decision.chosenAction.cardCodes
  ) {
    process.stdout.write(`  cardCodes=${decision.chosenAction.cardCodes.join(",")}\n`);
  }

  if (decision.destinationSelectionApplied) {
    process.stdout.write(
      `  destinationSelectionApplied kept=${decision.destinationSelectionApplied.kept.join(" | ")}\n`
    );
  }
}
