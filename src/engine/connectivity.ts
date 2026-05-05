import type { PlayerId, RouteDefinition, TicketDefinition } from "../model/board.js";
import type { PublicGameState } from "../model/game-state.js";

type Adjacency = Map<string, string[]>;

const buildClaimedAdjacency = (
  publicState: PublicGameState,
  playerId: PlayerId,
  routesById: Map<string, RouteDefinition>
): Adjacency => {
  const adjacency: Adjacency = new Map();

  for (const [routeId, ownerId] of Object.entries(publicState.claimedRoutes)) {
    if (ownerId !== playerId) {
      continue;
    }

    const route = routesById.get(routeId);

    if (!route) {
      continue;
    }

    adjacency.set(route.cityA, [...(adjacency.get(route.cityA) ?? []), route.cityB]);
    adjacency.set(route.cityB, [...(adjacency.get(route.cityB) ?? []), route.cityA]);
  }

  return adjacency;
};

export const areCitiesConnected = (
  publicState: PublicGameState,
  playerId: PlayerId,
  fromCity: string,
  toCity: string,
  routesById: Map<string, RouteDefinition>
): boolean => {
  if (fromCity === toCity) {
    return true;
  }

  const adjacency = buildClaimedAdjacency(publicState, playerId, routesById);
  const visited = new Set<string>([fromCity]);
  const queue = [fromCity];

  while (queue.length > 0) {
    const cityId = queue.shift();

    if (!cityId) {
      continue;
    }

    for (const neighbor of adjacency.get(cityId) ?? []) {
      if (neighbor === toCity) {
        return true;
      }

      if (visited.has(neighbor)) {
        continue;
      }

      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  return false;
};

export const evaluateTicketCompletion = (
  publicState: PublicGameState,
  playerId: PlayerId,
  tickets: TicketDefinition[],
  routesById: Map<string, RouteDefinition>
): Array<TicketDefinition & { completed: boolean }> =>
  tickets.map((currentTicket) => ({
    ...currentTicket,
    completed: areCitiesConnected(
      publicState,
      playerId,
      currentTicket.fromCity,
      currentTicket.toCity,
      routesById
    )
  }));

interface ClaimedEdge {
  routeId: string;
  cityA: string;
  cityB: string;
  length: number;
}

const getClaimedEdges = (
  publicState: PublicGameState,
  playerId: PlayerId,
  routesById: Map<string, RouteDefinition>
): ClaimedEdge[] => {
  const edges: ClaimedEdge[] = [];

  for (const [routeId, ownerId] of Object.entries(publicState.claimedRoutes)) {
    if (ownerId !== playerId) {
      continue;
    }

    const route = routesById.get(routeId);

    if (!route) {
      continue;
    }

    edges.push({
      routeId,
      cityA: route.cityA,
      cityB: route.cityB,
      length: route.length
    });
  }

  return edges;
};

export const getLongestRouteLength = (
  publicState: PublicGameState,
  playerId: PlayerId,
  routesById: Map<string, RouteDefinition>
): number => {
  const edges = getClaimedEdges(publicState, playerId, routesById);

  if (edges.length === 0) {
    return 0;
  }

  let best = 0;

  const dfs = (currentCity: string, usedRouteIds: Set<string>, currentLength: number): void => {
    best = Math.max(best, currentLength);

    for (const edge of edges) {
      if (usedRouteIds.has(edge.routeId)) {
        continue;
      }

      if (edge.cityA !== currentCity && edge.cityB !== currentCity) {
        continue;
      }

      const nextCity = edge.cityA === currentCity ? edge.cityB : edge.cityA;
      usedRouteIds.add(edge.routeId);
      dfs(nextCity, usedRouteIds, currentLength + edge.length);
      usedRouteIds.delete(edge.routeId);
    }
  };

  const startCities = new Set<string>();

  for (const edge of edges) {
    startCities.add(edge.cityA);
    startCities.add(edge.cityB);
  }

  for (const startCity of startCities) {
    dfs(startCity, new Set<string>(), 0);
  }

  return best;
};
