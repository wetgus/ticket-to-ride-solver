import { USA_BOARD } from "../data/usa-board.js";
import { indexRoutesById, indexRoutesByParallelGroup } from "../engine/board-index.js";
import { evaluateTicketCompletion, getLongestRouteLength } from "../engine/connectivity.js";
import { getLegalClaimRouteActions } from "../engine/legal-actions.js";
import { validateGameState } from "../engine/state-validation.js";
import { getScenarioById, SCENARIOS } from "../examples/scenarios.js";

const routesById = indexRoutesById(USA_BOARD.routes);
const routesByParallelGroup = indexRoutesByParallelGroup(USA_BOARD.routes);

const formatValidation = (scenarioId: string): string[] => {
  const scenario = getScenarioById(scenarioId);

  if (!scenario) {
    return [
      `Unknown scenario: ${scenarioId}`,
      "",
      "Available scenarios:",
      ...SCENARIOS.map((currentScenario) => `- ${currentScenario.id}: ${currentScenario.title}`)
    ];
  }

  const issues = validateGameState(scenario.gameState, routesById);
  const legalClaims = getLegalClaimRouteActions(
    scenario.gameState,
    USA_BOARD.routes,
    routesByParallelGroup
  );
  const ownedTickets = USA_BOARD.tickets.filter((ticket) =>
    scenario.gameState.ourState.ticketIds.includes(ticket.id)
  );
  const ticketStatuses = evaluateTicketCompletion(
    scenario.gameState.publicState,
    scenario.gameState.ourState.playerId,
    ownedTickets,
    routesById
  );
  const longestRouteLength = getLongestRouteLength(
    scenario.gameState.publicState,
    scenario.gameState.ourState.playerId,
    routesById
  );

  return [
    `${scenario.title} [${scenario.id}]`,
    scenario.description,
    "",
    `Validation issues: ${issues.length}`,
    ...issues.map((issue) => `- ${issue.severity.toUpperCase()}: ${issue.message}`),
    ...(issues.length === 0 ? ["- none"] : []),
    "",
    `Longest route length: ${longestRouteLength}`,
    "Ticket completion:",
    ...ticketStatuses.map(
      (ticket) =>
        `- ${ticket.id}: ${ticket.fromCity} -> ${ticket.toCity} | points=${ticket.points} | completed=${ticket.completed}`
    ),
    "",
    `Legal claim actions: ${legalClaims.length}`,
    ...legalClaims.slice(0, 20).map((action) => {
      const route = routesById.get(action.routeId);
      return route
        ? `- ${route.cityA} -> ${route.cityB} | len=${route.length} | color=${route.color} | pay ${action.payment.colorCards} ${action.payment.primaryColor} + ${action.payment.locomotives} loco`
        : `- unknown route ${action.routeId}`;
    }),
    ...(legalClaims.length > 20 ? [`- ... and ${legalClaims.length - 20} more`] : [])
  ];
};

const scenarioId = process.argv[2] ?? "sample-opening";
process.stdout.write(`${formatValidation(scenarioId).join("\n")}\n`);
