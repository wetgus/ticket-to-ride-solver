export type RawTrainCardCode = number;

export interface ParsedMoveHeader {
  moveNumber: number;
  timestamp: string;
}

export interface ReplayMetaEvent {
  kind:
    | "deck-reshuffled"
    | "visible-cards-reset"
    | "end-of-game";
}

export interface ReplayKeepDestinationsEvent {
  kind: "keep-destinations";
  playerName: string;
  count: number;
}

export interface ReplayDrawVisibleEvent {
  kind: "draw-visible";
  playerName: string;
  cardCode: RawTrainCardCode;
}

export interface ReplayDrawHiddenEvent {
  kind: "draw-hidden";
  playerName: string;
  cardCodes: RawTrainCardCode[];
}

export interface ReplayClaimRouteEvent {
  kind: "claim-route";
  playerName: string;
  points: number;
  fromCity: string;
  toCity: string;
  trainCarsUsed: number;
  cardCodes: RawTrainCardCode[];
}

export interface ReplayCompletedDestinationEvent {
  kind: "completed-destination";
  playerName: string;
  fromCity: string;
  toCity: string;
}

export interface ReplayRevealDestinationEvent {
  kind: "reveal-destination";
  playerName: string;
  fromCity: string;
  toCity: string;
  deltaPoints: number;
  completed: boolean;
}

export interface ReplayLongestPathEvent {
  kind: "longest-path";
  playerName: string;
  trainCars: number;
}

export interface ReplayFinalTurnTriggerEvent {
  kind: "final-turn-trigger";
  playerName: string;
}

export interface ReplayLongestPathBonusEvent {
  kind: "longest-path-bonus";
  playerName: string;
  points: number;
  trainCars: number;
}

export type ReplayParsedEvent =
  | ReplayMetaEvent
  | ReplayKeepDestinationsEvent
  | ReplayDrawVisibleEvent
  | ReplayDrawHiddenEvent
  | ReplayClaimRouteEvent
  | ReplayCompletedDestinationEvent
  | ReplayRevealDestinationEvent
  | ReplayLongestPathEvent
  | ReplayFinalTurnTriggerEvent
  | ReplayLongestPathBonusEvent;

export interface ParsedReplayMove {
  header: ParsedMoveHeader;
  events: ReplayParsedEvent[];
}

export interface ParsedReplayGame {
  moves: ParsedReplayMove[];
  players: string[];
}

export interface ParseBgaLogOptions {
  selfPlayerName?: string;
}

const MOVE_HEADER_PATTERN = /^Move\s+(\d+)\s*:(.+)$/;
const KEEP_DESTINATIONS_PATTERN = /^(.+?) keeps (\d+) destination\(s\)$/;
const DRAW_VISIBLE_PATTERN = /^(.+?) takes (\d+)$/;
const DRAW_HIDDEN_PATTERN = /^(.+?) takes hidden train car card\(s\) ([0-8](?:,[0-8])*)$/;
const DRAW_HIDDEN_EXPLICIT_COUNT_PATTERN = /^(.+?) takes (\d+) hidden train car card\(s\)$/;
const CLAIM_ROUTE_PATTERN =
  /^(.+?) gains (\d+) point\(s\) by claiming route from (.+?) to (.+?) with (\d+) train car\(s\) : ([0-8](?:,[0-8])*)$/;
const COMPLETED_DESTINATION_PATTERN = /^(.+?) completed a new destination : (.+?) - (.+)$/;
const REVEAL_DESTINATION_PATTERN =
  /^(.+?) reveals (.+?) to (.+?) destination$/;
const REVEAL_DELTA_PATTERN =
  /^(.+?) (gains|loses) (\d+) points with (.+?) to (.+?) destination$/;
const LONGEST_PATH_PATTERN =
  /^(.+?) longest continuous path is (\d+) train-cars long$/;
const LONGEST_PATH_BONUS_PATTERN =
  /^(.+?) gains (\d+) points with longest continuous path : (\d+) train cars$/;
const FINAL_TURN_PATTERN =
  /^(.+?) has 2 train cars or less, starting final turn !$/;

const getRequiredCapture = (
  captures: RegExpMatchArray,
  index: number
): string => {
  const value = captures[index];

  if (value === undefined) {
    throw new Error(`Missing regex capture at index ${index}.`);
  }

  return value;
};

const normalizeLines = (
  rawText: string,
  options: ParseBgaLogOptions
): string[] => {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const nextLine = lines[index + 1];

    if (!currentLine) {
      continue;
    }

    if (currentLine === nextLine) {
      continue;
    }

    if (currentLine.startsWith("You ") && nextLine && areMirrorLines(currentLine, nextLine)) {
      normalized.push(mergeMirrorLines(currentLine, nextLine, options));
      index += 1;
      continue;
    }

    normalized.push(currentLine);
  }

  return normalized;
};

const areMirrorLines = (firstLine: string, secondLine: string): boolean => {
  const hiddenA = firstLine.match(/^You take hidden train car card\(s\) ([0-8](?:,[0-8])*)$/);
  const hiddenB = secondLine.match(/^(.+?) takes (\d+) hidden train car card\(s\)$/);

  if (hiddenA && hiddenB) {
    return (
      getRequiredCapture(hiddenA, 1).split(",").length ===
      Number(getRequiredCapture(hiddenB, 2))
    );
  }

  return false;
};

const mergeMirrorLines = (
  firstLine: string,
  secondLine: string,
  options: ParseBgaLogOptions
): string => {
  const hiddenA = firstLine.match(/^You take hidden train car card\(s\) ([0-8](?:,[0-8])*)$/);
  const hiddenB = secondLine.match(/^(.+?) takes (\d+) hidden train car card\(s\)$/);

  if (hiddenA && hiddenB) {
    return `${normalizePlayerName(getRequiredCapture(hiddenB, 1), options)} takes hidden train car card(s) ${getRequiredCapture(hiddenA, 1)}`;
  }

  return firstLine;
};

const parseCardCodes = (rawCodes: string): RawTrainCardCode[] =>
  rawCodes.split(",").map((value) => Number(value));

const normalizePlayerName = (
  rawPlayerName: string,
  options: ParseBgaLogOptions
): string =>
  rawPlayerName === "You" && options.selfPlayerName
    ? options.selfPlayerName
    : rawPlayerName;

const parseNonMoveLine = (
  line: string,
  options: ParseBgaLogOptions
): ReplayParsedEvent[] => {
  if (line === "The train car deck has been reshuffled") {
    return [{ kind: "deck-reshuffled" }];
  }

  if (line === "Three locomotives have been revealed, visible train cards are replaced") {
    return [{ kind: "visible-cards-reset" }];
  }

  if (line === "End of game") {
    return [{ kind: "end-of-game" }];
  }

  const keepMatch = line.match(KEEP_DESTINATIONS_PATTERN);
  if (keepMatch) {
    return [
      {
        kind: "keep-destinations",
        playerName: normalizePlayerName(getRequiredCapture(keepMatch, 1), options),
        count: Number(getRequiredCapture(keepMatch, 2))
      }
    ];
  }

  const hiddenMatch = line.match(DRAW_HIDDEN_PATTERN);
  if (hiddenMatch) {
    return [
      {
        kind: "draw-hidden",
        playerName: normalizePlayerName(getRequiredCapture(hiddenMatch, 1), options),
        cardCodes: parseCardCodes(getRequiredCapture(hiddenMatch, 2))
      }
    ];
  }

  const hiddenExplicitCountMatch = line.match(DRAW_HIDDEN_EXPLICIT_COUNT_PATTERN);
  if (hiddenExplicitCountMatch) {
    return [
      {
        kind: "draw-hidden",
        playerName: normalizePlayerName(
          getRequiredCapture(hiddenExplicitCountMatch, 1),
          options
        ),
        cardCodes: Array.from(
          { length: Number(getRequiredCapture(hiddenExplicitCountMatch, 2)) },
          () => -1
        )
      }
    ];
  }

  const claimMatch = line.match(CLAIM_ROUTE_PATTERN);
  if (claimMatch) {
    return [
      {
        kind: "claim-route",
        playerName: normalizePlayerName(getRequiredCapture(claimMatch, 1), options),
        points: Number(getRequiredCapture(claimMatch, 2)),
        fromCity: getRequiredCapture(claimMatch, 3),
        toCity: getRequiredCapture(claimMatch, 4),
        trainCarsUsed: Number(getRequiredCapture(claimMatch, 5)),
        cardCodes: parseCardCodes(getRequiredCapture(claimMatch, 6))
      }
    ];
  }

  const completedMatch = line.match(COMPLETED_DESTINATION_PATTERN);
  if (completedMatch) {
    return [
      {
        kind: "completed-destination",
        playerName: normalizePlayerName(
          getRequiredCapture(completedMatch, 1),
          options
        ),
        fromCity: getRequiredCapture(completedMatch, 2),
        toCity: getRequiredCapture(completedMatch, 3)
      }
    ];
  }

  const revealMatch = line.match(REVEAL_DESTINATION_PATTERN);
  if (revealMatch) {
    return [
      {
        kind: "reveal-destination",
        playerName: normalizePlayerName(getRequiredCapture(revealMatch, 1), options),
        fromCity: getRequiredCapture(revealMatch, 2),
        toCity: getRequiredCapture(revealMatch, 3),
        deltaPoints: 0,
        completed: false
      }
    ];
  }

  const revealDeltaMatch = line.match(REVEAL_DELTA_PATTERN);
  if (revealDeltaMatch) {
    return [
      {
        kind: "reveal-destination",
        playerName: normalizePlayerName(
          getRequiredCapture(revealDeltaMatch, 1),
          options
        ),
        fromCity: getRequiredCapture(revealDeltaMatch, 4),
        toCity: getRequiredCapture(revealDeltaMatch, 5),
        deltaPoints:
          (getRequiredCapture(revealDeltaMatch, 2) === "gains" ? 1 : -1) *
          Number(getRequiredCapture(revealDeltaMatch, 3)),
        completed: getRequiredCapture(revealDeltaMatch, 2) === "gains"
      }
    ];
  }

  const longestPathMatch = line.match(LONGEST_PATH_PATTERN);
  if (longestPathMatch) {
    return [
      {
        kind: "longest-path",
        playerName: normalizePlayerName(
          getRequiredCapture(longestPathMatch, 1),
          options
        ),
        trainCars: Number(getRequiredCapture(longestPathMatch, 2))
      }
    ];
  }

  const longestPathBonusMatch = line.match(LONGEST_PATH_BONUS_PATTERN);
  if (longestPathBonusMatch) {
    return [
      {
        kind: "longest-path-bonus",
        playerName: normalizePlayerName(
          getRequiredCapture(longestPathBonusMatch, 1),
          options
        ),
        points: Number(getRequiredCapture(longestPathBonusMatch, 2)),
        trainCars: Number(getRequiredCapture(longestPathBonusMatch, 3))
      }
    ];
  }

  const finalTurnMatch = line.match(FINAL_TURN_PATTERN);
  if (finalTurnMatch) {
    return [
      {
        kind: "final-turn-trigger",
        playerName: normalizePlayerName(
          getRequiredCapture(finalTurnMatch, 1),
          options
        )
      }
    ];
  }

  const visibleMatch = line.match(DRAW_VISIBLE_PATTERN);
  if (visibleMatch) {
    return [
      {
        kind: "draw-visible",
        playerName: normalizePlayerName(getRequiredCapture(visibleMatch, 1), options),
        cardCode: Number(getRequiredCapture(visibleMatch, 2))
      }
    ];
  }

  return [];
};

export const parseBgaLog = (
  rawText: string,
  options: ParseBgaLogOptions = {}
): ParsedReplayGame => {
  const lines = normalizeLines(rawText, options);
  const moves: ParsedReplayMove[] = [];
  let currentMove: ParsedReplayMove | undefined;

  for (const line of lines) {
    const moveHeaderMatch = line.match(MOVE_HEADER_PATTERN);

    if (moveHeaderMatch) {
      currentMove = {
        header: {
          moveNumber: Number(getRequiredCapture(moveHeaderMatch, 1)),
          timestamp: getRequiredCapture(moveHeaderMatch, 2).trim()
        },
        events: []
      };
      moves.push(currentMove);
      continue;
    }

    if (!currentMove) {
      continue;
    }

    currentMove.events.push(...parseNonMoveLine(line, options));
  }

  const players = new Set<string>();

  for (const move of moves) {
    for (const event of move.events) {
      if ("playerName" in event) {
        players.add(event.playerName);
      }
    }
  }

  return {
    moves,
    players: [...players]
  };
};

export interface ParsedReplaySummary {
  players: string[];
  moveCount: number;
  claimCount: number;
  hiddenDrawCount: number;
  visibleDrawCount: number;
  finalTurnTriggeredBy?: string;
}

export const summarizeParsedReplay = (
  parsedReplay: ParsedReplayGame
): ParsedReplaySummary => {
  let claimCount = 0;
  let hiddenDrawCount = 0;
  let visibleDrawCount = 0;
  let finalTurnTriggeredBy: string | undefined;

  for (const move of parsedReplay.moves) {
    for (const event of move.events) {
      switch (event.kind) {
        case "claim-route":
          claimCount += 1;
          break;
        case "draw-hidden":
          hiddenDrawCount += 1;
          break;
        case "draw-visible":
          visibleDrawCount += 1;
          break;
        case "final-turn-trigger":
          finalTurnTriggeredBy = event.playerName;
          break;
        default:
          break;
      }
    }
  }

  return {
    players: parsedReplay.players,
    moveCount: parsedReplay.moves.length,
    claimCount,
    hiddenDrawCount,
    visibleDrawCount,
    ...(finalTurnTriggeredBy ? { finalTurnTriggeredBy } : {})
  };
};
