export const ROUTE_LENGTH_POINTS = {
  1: 1,
  2: 2,
  3: 4,
  4: 7,
  5: 10,
  6: 15
} as const;

export type RouteLength = keyof typeof ROUTE_LENGTH_POINTS;

export const getRoutePoints = (length: RouteLength): number =>
  ROUTE_LENGTH_POINTS[length];

export const LONGEST_ROUTE_BONUS = 10;
