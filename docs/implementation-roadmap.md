# Implementation Roadmap

## Current status

Already created:

- mathematical framing for the solver;
- strict TypeScript domain model;
- initial project structure for engine-first development.

Current code modules:

- `src/model/board.ts`
- `src/model/actions.ts`
- `src/model/game-state.ts`
- `src/model/replay.ts`
- `src/model/evaluation.ts`

## Next coding milestone

The next concrete implementation target is the exact rules layer:

1. USA board data.
2. Route claim legality.
3. Score updates for route claims.
4. Endgame trigger detection.
5. Longest-route graph utility.

## Why this comes next

Without exact transitions, the recommender cannot be tested on real positions.

Once the rules layer exists, we can:

- reconstruct games from logs;
- validate user-entered positions in the future UI;
- attach heuristic evaluation to legal actions only;
- benchmark recommendation quality on replay scenarios.

## Planned module additions

- `src/data/usa-board.ts`
- `src/engine/legal-actions.ts`
- `src/engine/apply-action.ts`
- `src/engine/scoring.ts`
- `src/engine/connectivity.ts`
- `src/engine/longest-route.ts`

## Data we should collect early

- raw turn-by-turn game logs;
- examples of difficult midgame decisions;
- examples of blocking situations;
- examples of endgame race positions.

That dataset will let us validate whether the first heuristic engine makes sensible choices before we invest in deeper simulation.
