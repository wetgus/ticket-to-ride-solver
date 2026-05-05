import type { RouteDefinition } from "../model/board.js";

export const indexRoutesById = (routes: RouteDefinition[]): Map<string, RouteDefinition> =>
  new Map(routes.map((route) => [route.id, route]));

export const indexRoutesByParallelGroup = (
  routes: RouteDefinition[]
): Map<string, RouteDefinition[]> => {
  const groups = new Map<string, RouteDefinition[]>();

  for (const currentRoute of routes) {
    if (!currentRoute.parallelGroup) {
      continue;
    }

    groups.set(currentRoute.parallelGroup, [
      ...(groups.get(currentRoute.parallelGroup) ?? []),
      currentRoute
    ]);
  }

  return groups;
};
