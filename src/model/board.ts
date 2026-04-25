export const TRAIN_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "black",
  "white",
  "orange",
  "pink",
  "locomotive"
] as const;

export type TrainColor = typeof TRAIN_COLORS[number];

export type RouteColor = Exclude<TrainColor, "locomotive"> | "gray";

export type CityId = string;
export type RouteId = string;
export type TicketId = string;
export type PlayerId = string;

export type TicketFamily =
  | "transcontinental"
  | "north-south"
  | "east-cluster"
  | "west-cluster"
  | "central-connector"
  | "southwest-pivot"
  | "canada-border"
  | "unknown";

export interface City {
  id: CityId;
  name: string;
  region:
    | "west"
    | "midwest"
    | "south"
    | "northeast"
    | "northwest"
    | "southwest"
    | "central";
}

export interface RouteDefinition {
  id: RouteId;
  cityA: CityId;
  cityB: CityId;
  length: 1 | 2 | 3 | 4 | 5 | 6;
  color: RouteColor;
  points: 1 | 2 | 4 | 7 | 10 | 15;
  isDoubleRoute: boolean;
  parallelGroup?: string;
  tags: string[];
}

export interface TicketDefinition {
  id: TicketId;
  fromCity: CityId;
  toCity: CityId;
  points: number;
  family: TicketFamily;
}

export interface BoardDefinition {
  mapId: "usa";
  cities: City[];
  routes: RouteDefinition[];
  tickets: TicketDefinition[];
}

export type ExtensionId = "base-usa";
