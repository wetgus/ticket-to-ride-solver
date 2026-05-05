import { USA_BOARD } from "../data/usa-board.js";
import type { GameState } from "../model/game-state.js";
import { createBaseRulesConfig } from "../model/game-state.js";

const zeroHand = () => ({
  red: 0,
  blue: 0,
  green: 0,
  yellow: 0,
  black: 0,
  white: 0,
  orange: 0,
  pink: 0,
  locomotive: 0
});

export const createSampleGameState = (): GameState => ({
  rules: createBaseRulesConfig(3),
  publicState: {
    currentPlayerId: "p1",
    firstPlayerId: "p1",
    turnNumber: 1,
    phase: "ready",
    playerOrder: ["p1", "p2", "p3"],
    players: [
      {
        playerId: "p1",
        displayName: "You",
        score: 0,
        trainsRemaining: 45,
        claimedRouteIds: [],
        ticketsDrawnCount: 0
      },
      {
        playerId: "p2",
        displayName: "Opponent 1",
        score: 0,
        trainsRemaining: 45,
        claimedRouteIds: [],
        ticketsDrawnCount: 0
      },
      {
        playerId: "p3",
        displayName: "Opponent 2",
        score: 0,
        trainsRemaining: 45,
        claimedRouteIds: [],
        ticketsDrawnCount: 0
      }
    ],
    faceUpCards: ["red", "blue", "green", "yellow", "locomotive"],
    discardCount: 0,
    drawPileCount: 110 - 5 - 4 * 3,
    claimedRoutes: {}
  },
  ourState: {
    playerId: "p1",
    trainsRemaining: 45,
    hand: {
      ...zeroHand(),
      red: 3,
      blue: 2,
      green: 2,
      locomotive: 1
    },
    ticketIds: [
      USA_BOARD.tickets.find((ticket) => ticket.id === "denver-el-paso")?.id ?? "denver-el-paso",
      USA_BOARD.tickets.find((ticket) => ticket.id === "new-york-atlanta")?.id ?? "new-york-atlanta"
    ]
  },
  beliefs: [
    {
      playerId: "p2",
      handColorLowerBounds: {},
      handColorExpectedCounts: {},
      ticketFamilyPosterior: [],
      archetypePosterior: [],
      corridorInterest: []
    },
    {
      playerId: "p3",
      handColorLowerBounds: {},
      handColorExpectedCounts: {},
      ticketFamilyPosterior: [],
      archetypePosterior: [],
      corridorInterest: []
    }
  ],
  annotations: {
    activePlanTags: [],
    securedTicketIds: [],
    atRiskTicketIds: [],
    bottleneckRouteIds: []
  }
});

export const createInitialTicketChoiceGameState = (): GameState => ({
  rules: createBaseRulesConfig(3),
  publicState: {
    currentPlayerId: "p1",
    firstPlayerId: "p1",
    turnNumber: 0,
    phase: "resolving-ticket-keep",
    playerOrder: ["p1", "p2", "p3"],
    players: [
      {
        playerId: "p1",
        displayName: "You",
        score: 0,
        trainsRemaining: 45,
        claimedRouteIds: [],
        ticketsDrawnCount: 1
      },
      {
        playerId: "p2",
        displayName: "Opponent 1",
        score: 0,
        trainsRemaining: 45,
        claimedRouteIds: [],
        ticketsDrawnCount: 1
      },
      {
        playerId: "p3",
        displayName: "Opponent 2",
        score: 0,
        trainsRemaining: 45,
        claimedRouteIds: [],
        ticketsDrawnCount: 1
      }
    ],
    faceUpCards: [],
    discardCount: 0,
    drawPileCount: 110 - 4 * 3,
    claimedRoutes: {}
  },
  ourState: {
    playerId: "p1",
    trainsRemaining: 45,
    hand: {
      ...zeroHand(),
      red: 1,
      blue: 1,
      green: 1,
      yellow: 1
    },
    ticketIds: []
  },
  beliefs: [
    {
      playerId: "p2",
      handColorLowerBounds: {},
      handColorExpectedCounts: {},
      ticketFamilyPosterior: [],
      archetypePosterior: [],
      corridorInterest: []
    },
    {
      playerId: "p3",
      handColorLowerBounds: {},
      handColorExpectedCounts: {},
      ticketFamilyPosterior: [],
      archetypePosterior: [],
      corridorInterest: []
    }
  ],
  pendingTicketChoice: {
    playerId: "p1",
    offeredTicketIds: [
      "duluth-el-paso",
      "winnipeg-houston",
      "portland-nashville"
    ],
    minimumKeepCount: 2
  },
  annotations: {
    activePlanTags: [],
    securedTicketIds: [],
    atRiskTicketIds: [],
    bottleneckRouteIds: []
  }
});
