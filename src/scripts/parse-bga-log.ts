import fs from "node:fs";
import path from "node:path";
import { parseBgaLog, summarizeParsedReplay } from "../replay/bga-log-parser.js";

const logPath = process.argv[2];
const selfPlayerName = process.argv[3];

if (!logPath) {
  process.stderr.write("Usage: node dist/scripts/parse-bga-log.js <path-to-log.txt>\n");
  process.exit(1);
}

const absolutePath = path.resolve(logPath);
const rawText = fs.readFileSync(absolutePath, "utf8");
const parsedReplay = parseBgaLog(
  rawText,
  selfPlayerName ? { selfPlayerName } : {}
);
const summary = summarizeParsedReplay(parsedReplay);

process.stdout.write(`Parsed replay: ${absolutePath}\n`);
process.stdout.write(`Players: ${summary.players.join(", ")}\n`);
process.stdout.write(`Moves: ${summary.moveCount}\n`);
process.stdout.write(`Claims: ${summary.claimCount}\n`);
process.stdout.write(`Visible draws: ${summary.visibleDrawCount}\n`);
process.stdout.write(`Hidden draws: ${summary.hiddenDrawCount}\n`);
process.stdout.write(
  `Final turn triggered by: ${summary.finalTurnTriggeredBy ?? "unknown / not found"}\n`
);
process.stdout.write("\nFirst 12 parsed events:\n");

const flattenedEvents = parsedReplay.moves.flatMap((move) =>
  move.events.map((event) => ({
    moveNumber: move.header.moveNumber,
    timestamp: move.header.timestamp,
    event
  }))
);

for (const currentEntry of flattenedEvents.slice(0, 12)) {
  process.stdout.write(
    `- Move ${currentEntry.moveNumber} @ ${currentEntry.timestamp}: ${JSON.stringify(currentEntry.event)}\n`
  );
}
