import fs from "node:fs";
import path from "node:path";
import { USA_BOARD } from "../data/usa-board.js";
import { parseBgaLog } from "../replay/bga-log-parser.js";
import { reconstructReplayState } from "../replay/reconstruction.js";

const logPath = process.argv[2];
const selfPlayerName = process.argv[3];

if (!logPath) {
  process.stderr.write(
    "Usage: node dist/scripts/reconstruct-bga-log.js <path-to-log.txt> [self-player-name]\n"
  );
  process.exit(1);
}

const absolutePath = path.resolve(logPath);
const rawText = fs.readFileSync(absolutePath, "utf8");
const parsedReplay = parseBgaLog(
  rawText,
  selfPlayerName ? { selfPlayerName } : {}
);
const reconstruction = reconstructReplayState(
  parsedReplay,
  USA_BOARD,
  selfPlayerName
);
const finalSnapshot = reconstruction.finalSnapshot;

process.stdout.write(`Replay reconstruction: ${absolutePath}\n`);
process.stdout.write(
  `Snapshots: ${reconstruction.snapshots.length}, final move: ${finalSnapshot.moveNumber}\n`
);

process.stdout.write("\nFinal public player states:\n");
for (const player of finalSnapshot.players.sort((a, b) => b.score - a.score)) {
  process.stdout.write(
    `- ${player.playerName}: score=${player.score} trainsRemaining=${player.trainsRemaining} claimedRoutes=${player.claimedRouteIds.length} visibleDraws=${player.visibleDrawCount} hiddenDraws=${player.hiddenDrawCount}\n`
  );
}

if (finalSnapshot.finalTurnTriggeredBy) {
  process.stdout.write(`\nFinal turn triggered by: ${finalSnapshot.finalTurnTriggeredBy}\n`);
}

if (finalSnapshot.selfKnownState) {
  process.stdout.write(`\nKnown self hand for ${finalSnapshot.selfKnownState.playerName}:\n`);
  for (const [color, count] of Object.entries(finalSnapshot.selfKnownState.exactKnownCards)) {
    process.stdout.write(`- ${color}: ${count}\n`);
  }
  process.stdout.write(
    `- unknownHiddenDrawCount: ${finalSnapshot.selfKnownState.unknownHiddenDrawCount}\n`
  );
}
