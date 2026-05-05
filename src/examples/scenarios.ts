import { USA_BOARD } from "../data/usa-board.js";
import type { GameState } from "../model/game-state.js";
import { createInitialTicketChoiceGameState, createSampleGameState } from "./sample-state.js";

export interface ScenarioDefinition {
  id: string;
  title: string;
  description: string;
  gameState: GameState;
}

const createContestedWestScenario = (): GameState => {
  const base = createSampleGameState();

  return {
    ...base,
    publicState: {
      ...base.publicState,
      turnNumber: 8,
      players: base.publicState.players.map((player) => {
        if (player.playerId === "p1") {
          return {
            ...player,
            score: 12,
            trainsRemaining: 39,
            claimedRouteIds: ["los-angeles-las-vegas-gray-2", "las-vegas-salt-lake-city-orange-3"]
          };
        }

        if (player.playerId === "p2") {
          return {
            ...player,
            score: 11,
            trainsRemaining: 40,
            claimedRouteIds: ["phoenix-los-angeles-gray-3", "el-paso-phoenix-gray-3"]
          };
        }

        return player;
      }),
      claimedRoutes: {
        "los-angeles-las-vegas-gray-2": "p1",
        "las-vegas-salt-lake-city-orange-3": "p1",
        "phoenix-los-angeles-gray-3": "p2",
        "el-paso-phoenix-gray-3": "p2"
      }
    },
    ourState: {
      ...base.ourState,
      trainsRemaining: 39,
      hand: {
        red: 0,
        blue: 0,
        green: 0,
        yellow: 4,
        black: 6,
        white: 1,
        orange: 0,
        pink: 0,
        locomotive: 1
      },
      ticketIds: [
        USA_BOARD.tickets.find((ticket) => ticket.id === "los-angeles-new-york")?.id ?? "los-angeles-new-york",
        USA_BOARD.tickets.find((ticket) => ticket.id === "calgary-phoenix")?.id ?? "calgary-phoenix"
      ]
    }
  };
};

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: "initial-ticket-choice",
    title: "Initial Ticket Choice",
    description:
      "Start-of-game state before the first real turn, where you choose which initial destination tickets to keep.",
    gameState: createInitialTicketChoiceGameState()
  },
  {
    id: "sample-opening",
    title: "Sample Opening",
    description: "Early-turn sample state with a small mixed hand and no claimed routes.",
    gameState: createSampleGameState()
  },
  {
    id: "contested-west",
    title: "Contested West",
    description:
      "Midgame western race where Phoenix and Los Angeles are already under pressure and black/yellow resources matter.",
    gameState: createContestedWestScenario()
  }
];

export const getScenarioById = (scenarioId: string): ScenarioDefinition | undefined =>
  SCENARIOS.find((scenario) => scenario.id === scenarioId);
