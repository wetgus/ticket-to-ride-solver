# USA Base Feature Backlog

## Why this backlog exists

The solver should not hard-code folk wisdom like:

- "always draw blind to 20-30 cards"
- "never draw extra tickets"
- "never take a single face-up locomotive"

Those are not rules. They are **strong priors** that work in many base-USA 4-5 player positions.

The solver should treat them as:

- default tendencies when it has no stronger evidence
- overridable when the current position clearly says otherwise

This backlog converts practical strategy heuristics into measurable features.

## High-priority feature groups

### 1. Opening posture

These features capture the idea that early blind drawing is often good until the board starts to punish passivity.

Candidate features:

1. `openingBlindDrawStreak`
2. `openingHandSizeBand`
3. `openingLocomotiveDensity`
4. `openingPressureToStopDrawing`
5. `openingFlexibilityScore`

Interpretation:

- high flexibility + low board pressure -> blind draw often remains good
- low flexibility + high route-closing pressure -> start claiming

### 2. Ticket geometry

This is the most important new block.

We want to evaluate not just whether a ticket is connected, but how robust and efficient the connection plan is.

Candidate features:

1. `ticketPathCount`
2. `ticketBestPathTrainLength`
3. `ticketBestPathTurnCount`
4. `ticketBestPathRoutePoints`
5. `ticketSecondBestPathPenalty`
6. `ticketDetourPenalty`
7. `ticketBottleneckCount`
8. `ticketSharedBackboneScore`
9. `ticketLongRouteSynergy`

Interpretation:

- more alternative paths -> more freedom to keep drawing early
- higher detour penalty -> claim critical connectors sooner
- higher shared-backbone score -> ticket set is more coherent

### 3. Bottlenecks and narrow corridors

This block captures cases like:

- `Atlanta - Nashville`
- `Houston - New Orleans`

Candidate features:

1. `bottleneckUrgency`
2. `bottleneckReplacementCost`
3. `bottleneckTurnLossIfBlocked`
4. `bottleneckPointLossIfBlocked`
5. `criticalCorridorCount`

Interpretation:

- if a route is hard to replace and costs several turns to detour around, it should rise sharply in priority

### 4. Opponent route seizure risk

This block captures:

- visible color accumulation
- recent claim direction
- corridor intention

Candidate features:

1. `opponentSeizureRisk(routeId)`
2. `opponentCorridorIntent(routeId)`
3. `opponentCanClaimSoon(routeId)`
4. `opponentClockThreat`
5. `opponentLikelyExpansionDirection`

Interpretation:

- if an opponent is clearly marching west and a route matters to us, delaying the claim should become more expensive

### 5. Ticket draw EV

This block captures when drawing new tickets is good.

Candidate features:

1. `coveredTicketDrawProbability`
2. `nearCoveredTicketDrawProbability`
3. `ticketDrawExpectedNetValue`
4. `ticketDrawExpectedTurnCost`
5. `ticketDrawEndgameRisk`
6. `ticketDrawCatchUpValue`
7. `ticketDrawWinMoreValue`

Interpretation:

- if we are behind and our network already spans valuable corridors, ticket draw may be our best comeback line
- if endgame is imminent, ticket draw should usually be penalized

## First implementation wave

These are the first features I recommend implementing before anything else:

1. `ticketPathCount`
2. `ticketSecondBestPathPenalty`
3. `ticketDetourPenalty`
4. `bottleneckUrgency`
5. `opponentSeizureRisk`
6. `coveredTicketDrawProbability`
7. `nearCoveredTicketDrawProbability`
8. `opponentClockThreat`

Reason:

- these directly connect to decisions we already know the current bot mishandles:
  - drawing too long
  - missing narrow routes
  - underestimating ticket draw context
  - not reacting enough to visible opponent direction

## Suggested code ownership

### Route and ticket geometry

Primary file:

- [src/engine/recommendations.ts](../src/engine/recommendations.ts)

Likely new helper area:

- `ticket path analysis`
- `alternative path scoring`
- `detour penalty scoring`

### Learned feature exposure

Primary file:

- [src/training/feature-vector.ts](../src/training/feature-vector.ts)

We should expose only stable aggregate values here, not huge raw structures.

### Evaluation surface

Primary file:

- [src/model/evaluation.ts](../src/model/evaluation.ts)

If a new feature becomes important enough to debug directly, it can become part of `EvaluationFeatures`.

## First manual ablation plan

Before adding new features, the cleanest first simplification is:

- remove phase indicator features from learning
- remove `playerCount`
- optionally collapse individual known color counts into:
  - `knownHandSize`
  - `knownLocomotiveCount`

Why:

- current corpora are mostly 4-player USA
- phase is already split externally
- some of these features are likely redundant

## Guiding principle

The solver should act like this:

- if no clear tactical danger exists, use strong practical priors
- if the position provides strong contrary evidence, break the prior confidently

That is exactly what these features are meant to support.
