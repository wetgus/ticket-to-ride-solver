import type { BoardDefinition, RouteDefinition, TicketDefinition, TrainColor } from "../model/board.js";
import type {
  ParsedReplayGame,
  ReplayClaimRouteEvent,
  ReplayCompletedDestinationEvent,
  ReplayDrawHiddenEvent,
  ReplayDrawVisibleEvent,
  ReplayLongestPathEvent,
  ReplayRevealDestinationEvent
} from "./bga-log-parser.js";

export const BGA_TRAIN_CARD_CODE_MAP: Record<number, TrainColor> = {
  0: "locomotive",
  1: "pink",
  2: "white",
  3: "blue",
  4: "yellow",
  5: "orange",
  6: "black",
  7: "red",
  8: "green"
};

const CITY_NAME_ALIASES: Record<string, string> = {
  montreal: "montreal",
  "montral": "montreal",
  "montraal": "montreal",
  "montra©al": "montreal",
  "montra©l": "montreal",
  "montrã©al": "montreal",
  "saint louis": "saint louis",
  "st louis": "saint louis",
  "sault st marie": "sault ste marie",
  "sault ste marie": "sault ste marie"
};

const withOptional = <T extends object, K extends string, V>(
  key: K,
  value: V | undefined
): Partial<T & Record<K, V>> => (value === undefined ? {} : { [key]: value }) as Partial<
  T & Record<K, V>
>;

const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Ã©/g, "e")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();

const canonicalizeCityName = (rawCityName: string): string =>
  CITY_NAME_ALIASES[normalizeText(rawCityName)] ?? normalizeText(rawCityName);

const buildCityNameIndex = (board: BoardDefinition): Map<string, string> => {
  const index = new Map<string, string>();

  for (const currentCity of board.cities) {
    index.set(canonicalizeCityName(currentCity.name), currentCity.id);
  }

  return index;
};

const routeMatchesCities = (
  route: RouteDefinition,
  cityA: string,
  cityB: string
): boolean =>
  (route.cityA === cityA && route.cityB === cityB) ||
  (route.cityA === cityB && route.cityB === cityA);

export interface DecodedDrawEvent {
  playerName: string;
  color?: TrainColor;
  cardCode: number;
  visibility: "visible" | "hidden";
}

export interface NormalizedClaim {
  playerName: string;
  fromCityId?: string;
  toCityId?: string;
  routeId?: string;
  routeCandidates: string[];
  points: number;
  trainCarsUsed: number;
  decodedCardColors: TrainColor[];
  inferredClaimColor?: TrainColor;
  usedLocomotiveCount: number;
  scoreMatchesBoard: boolean;
}

export interface NormalizedDestinationEvent {
  playerName: string;
  ticketId?: string;
  fromCityId?: string;
  toCityId?: string;
  fromCityName: string;
  toCityName: string;
  points?: number;
  completed?: boolean;
  source: "completed" | "revealed";
}

export interface PlayerReplaySummary {
  playerName: string;
  routeClaimCount: number;
  matchedRouteClaimCount: number;
  visibleDrawCount: number;
  hiddenDrawCount: number;
  completedDestinationCount: number;
  revealedDestinationCount: number;
  finalLongestPathLength?: number;
}

export interface ReplayBoardAnalysis {
  players: PlayerReplaySummary[];
  claims: NormalizedClaim[];
  destinationEvents: NormalizedDestinationEvent[];
  unmatchedClaims: NormalizedClaim[];
}

const buildTicketIndex = (board: BoardDefinition): Map<string, TicketDefinition> => {
  const index = new Map<string, TicketDefinition>();

  for (const ticket of board.tickets) {
    const forwardKey = `${ticket.fromCity}|${ticket.toCity}`;
    const reverseKey = `${ticket.toCity}|${ticket.fromCity}`;
    index.set(forwardKey, ticket);
    index.set(reverseKey, ticket);
  }

  return index;
};

const decodeCardCodes = (cardCodes: number[]): TrainColor[] =>
  cardCodes.flatMap((code) => {
    const color = BGA_TRAIN_CARD_CODE_MAP[code];
    return color ? [color] : [];
  });

const inferClaimColor = (decodedCardColors: TrainColor[]): TrainColor | undefined => {
  const nonLocomotiveColors = decodedCardColors.filter(
    (color): color is Exclude<TrainColor, "locomotive"> => color !== "locomotive"
  );
  const uniqueColors = [...new Set(nonLocomotiveColors)];
  return uniqueColors.length === 1 ? uniqueColors[0] : undefined;
};

const normalizeClaimEvent = (
  event: ReplayClaimRouteEvent,
  board: BoardDefinition,
  cityNameIndex: Map<string, string>
): NormalizedClaim => {
  const fromCityId = cityNameIndex.get(canonicalizeCityName(event.fromCity));
  const toCityId = cityNameIndex.get(canonicalizeCityName(event.toCity));
  const decodedCardColors = decodeCardCodes(event.cardCodes);
  const inferredClaimColor = inferClaimColor(decodedCardColors);
  const usedLocomotiveCount = decodedCardColors.filter(
    (color) => color === "locomotive"
  ).length;

  const routeCandidates = board.routes.filter((route) => {
    if (!fromCityId || !toCityId) {
      return false;
    }

    return (
      route.length === event.trainCarsUsed &&
      routeMatchesCities(route, fromCityId, toCityId)
    );
  });

  const colorMatchedRoute =
    inferredClaimColor === undefined
      ? undefined
      : routeCandidates.find((route) =>
          route.color === "gray" || route.color === inferredClaimColor
        );

  const resolvedRoute =
    routeCandidates.length === 1
      ? routeCandidates[0]
      : colorMatchedRoute;

  return {
    playerName: event.playerName,
    routeCandidates: routeCandidates.map((route) => route.id),
    points: event.points,
    trainCarsUsed: event.trainCarsUsed,
    decodedCardColors,
    usedLocomotiveCount,
    scoreMatchesBoard: resolvedRoute ? resolvedRoute.points === event.points : false,
    ...withOptional<NormalizedClaim, "fromCityId", string>("fromCityId", fromCityId),
    ...withOptional<NormalizedClaim, "toCityId", string>("toCityId", toCityId),
    ...withOptional<NormalizedClaim, "routeId", string>("routeId", resolvedRoute?.id),
    ...withOptional<NormalizedClaim, "inferredClaimColor", TrainColor>(
      "inferredClaimColor",
      inferredClaimColor
    )
  };
};

const normalizeCompletedDestinationEvent = (
  event: ReplayCompletedDestinationEvent,
  cityNameIndex: Map<string, string>,
  ticketIndex: Map<string, TicketDefinition>
): NormalizedDestinationEvent => {
  const fromCityId = cityNameIndex.get(canonicalizeCityName(event.fromCity));
  const toCityId = cityNameIndex.get(canonicalizeCityName(event.toCity));
  const matchedTicket =
    fromCityId && toCityId
      ? ticketIndex.get(`${fromCityId}|${toCityId}`)
      : undefined;

  return {
    playerName: event.playerName,
    fromCityName: event.fromCity,
    toCityName: event.toCity,
    completed: true,
    source: "completed",
    ...withOptional<NormalizedDestinationEvent, "ticketId", string>(
      "ticketId",
      matchedTicket?.id
    ),
    ...withOptional<NormalizedDestinationEvent, "fromCityId", string>(
      "fromCityId",
      fromCityId
    ),
    ...withOptional<NormalizedDestinationEvent, "toCityId", string>(
      "toCityId",
      toCityId
    ),
    ...withOptional<NormalizedDestinationEvent, "points", number>(
      "points",
      matchedTicket?.points
    )
  };
};

const normalizeRevealedDestinationEvent = (
  event: ReplayRevealDestinationEvent,
  cityNameIndex: Map<string, string>,
  ticketIndex: Map<string, TicketDefinition>
): NormalizedDestinationEvent => {
  const fromCityId = cityNameIndex.get(canonicalizeCityName(event.fromCity));
  const toCityId = cityNameIndex.get(canonicalizeCityName(event.toCity));
  const matchedTicket =
    fromCityId && toCityId
      ? ticketIndex.get(`${fromCityId}|${toCityId}`)
      : undefined;

  return {
    playerName: event.playerName,
    fromCityName: event.fromCity,
    toCityName: event.toCity,
    source: "revealed",
    ...withOptional<NormalizedDestinationEvent, "ticketId", string>(
      "ticketId",
      matchedTicket?.id
    ),
    ...withOptional<NormalizedDestinationEvent, "fromCityId", string>(
      "fromCityId",
      fromCityId
    ),
    ...withOptional<NormalizedDestinationEvent, "toCityId", string>(
      "toCityId",
      toCityId
    ),
    ...withOptional<NormalizedDestinationEvent, "points", number>(
      "points",
      event.deltaPoints === 0
        ? undefined
        : matchedTicket?.points ?? Math.abs(event.deltaPoints)
    ),
    ...withOptional<NormalizedDestinationEvent, "completed", boolean>(
      "completed",
      event.deltaPoints === 0 ? undefined : event.completed
    )
  };
};

const mergeDestinationEvents = (
  destinationEvents: NormalizedDestinationEvent[]
): NormalizedDestinationEvent[] => {
  const mergedReveals = new Map<string, NormalizedDestinationEvent>();
  const passthrough: NormalizedDestinationEvent[] = [];

  for (const currentEvent of destinationEvents) {
    if (currentEvent.source !== "revealed") {
      passthrough.push(currentEvent);
      continue;
    }

    const key = `${currentEvent.playerName}|${currentEvent.fromCityName}|${currentEvent.toCityName}|revealed`;
    const previous = mergedReveals.get(key);

    if (!previous) {
      mergedReveals.set(key, currentEvent);
      continue;
    }

    mergedReveals.set(key, {
      ...previous,
      ...withOptional<NormalizedDestinationEvent, "ticketId", string>(
        "ticketId",
        previous.ticketId ?? currentEvent.ticketId
      ),
      ...withOptional<NormalizedDestinationEvent, "fromCityId", string>(
        "fromCityId",
        previous.fromCityId ?? currentEvent.fromCityId
      ),
      ...withOptional<NormalizedDestinationEvent, "toCityId", string>(
        "toCityId",
        previous.toCityId ?? currentEvent.toCityId
      ),
      ...withOptional<NormalizedDestinationEvent, "points", number>(
        "points",
        previous.points ?? currentEvent.points
      ),
      ...withOptional<NormalizedDestinationEvent, "completed", boolean>(
        "completed",
        previous.completed ?? currentEvent.completed
      )
    });
  }

  return [...passthrough, ...mergedReveals.values()];
};

export const analyzeReplayAgainstBoard = (
  parsedReplay: ParsedReplayGame,
  board: BoardDefinition
): ReplayBoardAnalysis => {
  const cityNameIndex = buildCityNameIndex(board);
  const ticketIndex = buildTicketIndex(board);
  const claims: NormalizedClaim[] = [];
  const destinationEvents: NormalizedDestinationEvent[] = [];
  const visibleDrawsByPlayer = new Map<string, number>();
  const hiddenDrawsByPlayer = new Map<string, number>();
  const longestPathsByPlayer = new Map<string, number>();

  for (const move of parsedReplay.moves) {
    for (const event of move.events) {
      switch (event.kind) {
        case "claim-route":
          claims.push(normalizeClaimEvent(event, board, cityNameIndex));
          break;
        case "completed-destination":
          destinationEvents.push(
            normalizeCompletedDestinationEvent(event, cityNameIndex, ticketIndex)
          );
          break;
        case "reveal-destination":
          destinationEvents.push(
            normalizeRevealedDestinationEvent(event, cityNameIndex, ticketIndex)
          );
          break;
        case "draw-visible":
          visibleDrawsByPlayer.set(
            event.playerName,
            (visibleDrawsByPlayer.get(event.playerName) ?? 0) + 1
          );
          break;
        case "draw-hidden":
          hiddenDrawsByPlayer.set(
            event.playerName,
            (hiddenDrawsByPlayer.get(event.playerName) ?? 0) + 1
          );
          break;
        case "longest-path":
          longestPathsByPlayer.set(event.playerName, event.trainCars);
          break;
        default:
          break;
      }
    }
  }

  const players = parsedReplay.players.map((playerName) => {
    const routeClaims = claims.filter((claim) => claim.playerName === playerName);
    const completedDestinations = destinationEvents.filter(
      (event) => event.playerName === playerName && event.source === "completed"
    );
    const revealedDestinations = destinationEvents.filter(
      (event) => event.playerName === playerName && event.source === "revealed"
    );

    const basePlayerSummary: PlayerReplaySummary = {
      playerName,
      routeClaimCount: routeClaims.length,
      matchedRouteClaimCount: routeClaims.filter((claim) => Boolean(claim.routeId)).length,
      visibleDrawCount: visibleDrawsByPlayer.get(playerName) ?? 0,
      hiddenDrawCount: hiddenDrawsByPlayer.get(playerName) ?? 0,
      completedDestinationCount: completedDestinations.length,
      revealedDestinationCount: revealedDestinations.length
    };

    return {
      ...basePlayerSummary,
      ...withOptional<PlayerReplaySummary, "finalLongestPathLength", number>(
        "finalLongestPathLength",
        longestPathsByPlayer.get(playerName)
      )
    };
  });

  const mergedDestinationEvents = mergeDestinationEvents(destinationEvents);

  return {
    players,
    claims,
    destinationEvents: mergedDestinationEvents,
    unmatchedClaims: claims.filter((claim) => !claim.routeId)
  };
};

export const decodeVisibleDrawEvent = (
  event: ReplayDrawVisibleEvent
): DecodedDrawEvent => ({
  playerName: event.playerName,
  cardCode: event.cardCode,
  visibility: "visible",
  ...withOptional<DecodedDrawEvent, "color", TrainColor>(
    "color",
    BGA_TRAIN_CARD_CODE_MAP[event.cardCode]
  )
});

export const decodeHiddenDrawEvent = (
  event: ReplayDrawHiddenEvent
): DecodedDrawEvent[] =>
  event.cardCodes.map((cardCode) => ({
    playerName: event.playerName,
    cardCode,
    visibility: "hidden",
    ...withOptional<DecodedDrawEvent, "color", TrainColor>(
      "color",
      BGA_TRAIN_CARD_CODE_MAP[cardCode]
    )
  }));

export const getReplayClaimTimelineForPlayer = (
  analysis: ReplayBoardAnalysis,
  playerName: string
): NormalizedClaim[] =>
  analysis.claims.filter((claim) => claim.playerName === playerName);

export const getReplayDestinationTimelineForPlayer = (
  analysis: ReplayBoardAnalysis,
  playerName: string
): NormalizedDestinationEvent[] =>
  analysis.destinationEvents.filter((event) => event.playerName === playerName);
