import fs from "node:fs";
import path from "node:path";
import { USA_BOARD } from "../data/usa-board.js";
import { analyzeReplayAgainstBoard, getReplayClaimTimelineForPlayer, getReplayDestinationTimelineForPlayer } from "../replay/bga-normalization.js";
import { parseBgaLog } from "../replay/bga-log-parser.js";

const logPath = process.argv[2];
const selfPlayerName = process.argv[3];

if (!logPath) {
  process.stderr.write(
    "Usage: node dist/scripts/analyze-bga-log.js <path-to-log.txt> [self-player-name]\n"
  );
  process.exit(1);
}

const absolutePath = path.resolve(logPath);
const rawText = fs.readFileSync(absolutePath, "utf8");
const parsedReplay = parseBgaLog(
  rawText,
  selfPlayerName ? { selfPlayerName } : {}
);
const analysis = analyzeReplayAgainstBoard(parsedReplay, USA_BOARD);

process.stdout.write(`Replay analysis: ${absolutePath}\n`);
process.stdout.write(`Players: ${analysis.players.map((player) => player.playerName).join(", ")}\n`);
process.stdout.write(
  `Matched claims: ${analysis.claims.filter((claim) => claim.routeId).length}/${analysis.claims.length}\n`
);
process.stdout.write(`Unmatched claims: ${analysis.unmatchedClaims.length}\n`);
process.stdout.write("\nPlayer summaries:\n");

for (const player of analysis.players) {
  process.stdout.write(
    `- ${player.playerName}: claims=${player.routeClaimCount} matched=${player.matchedRouteClaimCount} visibleDraws=${player.visibleDrawCount} hiddenDraws=${player.hiddenDrawCount} completedDestinations=${player.completedDestinationCount} revealedDestinations=${player.revealedDestinationCount} longestPath=${player.finalLongestPathLength ?? "?"}\n`
  );
}

if (selfPlayerName) {
  process.stdout.write(`\n${selfPlayerName} route timeline:\n`);

  for (const claim of getReplayClaimTimelineForPlayer(analysis, selfPlayerName)) {
    process.stdout.write(
      `- ${claim.fromCityId ?? "?"} -> ${claim.toCityId ?? "?"} | route=${claim.routeId ?? "unmatched"} | points=${claim.points} | cards=${claim.decodedCardColors.join(",")}\n`
    );
  }

  process.stdout.write(`\n${selfPlayerName} destination timeline:\n`);

  for (const destinationEvent of getReplayDestinationTimelineForPlayer(
    analysis,
    selfPlayerName
  )) {
    process.stdout.write(
      `- ${destinationEvent.source} | ${destinationEvent.fromCityName} -> ${destinationEvent.toCityName} | ticket=${destinationEvent.ticketId ?? "unmatched"} | completed=${destinationEvent.completed ?? "?"} | points=${destinationEvent.points ?? "?"}\n`
    );
  }
}

if (analysis.unmatchedClaims.length > 0) {
  process.stdout.write("\nUnmatched claims:\n");

  for (const claim of analysis.unmatchedClaims) {
    process.stdout.write(
      `- ${claim.playerName}: ${claim.fromCityId ?? "?"} -> ${claim.toCityId ?? "?"} | points=${claim.points} | trainCars=${claim.trainCarsUsed} | inferredColor=${claim.inferredClaimColor ?? "unknown"} | candidates=${claim.routeCandidates.join(",")}\n`
    );
  }
}
