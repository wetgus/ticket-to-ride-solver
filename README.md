# Ticket to Ride Solver

Web-based decision support tool for Ticket to Ride on the standard USA map.

## Repository status

The repository already contains:

- a mathematical design for the recommendation engine;
- a TypeScript domain model for game state, actions, replay logs, and evaluation outputs;
- an implementation roadmap for the next engine modules.

See also:

- [Mathematical model](./docs/mathematical-model.md)
- [Implementation roadmap](./docs/implementation-roadmap.md)

## Project goal

Build a practical recommendation engine that:

1. Tracks the full public game state and the player's private state.
2. Updates that state turn by turn from a convenient interface.
3. Recommends the strongest action in the current position.
4. Adapts recommendations to player count and rules/extensions.

The initial scope is limited to the standard USA map.

## Product vision

This is not just a static strategy guide. The target system is an interactive solver that combines:

- exact game rules and board constraints;
- probabilistic inference about hidden information;
- heuristic and statistical evaluation of plans;
- empirical tuning from real match logs and online testing.

## Core modeling choice

Ticket to Ride is a stochastic, partially observable, multi-player sequential decision problem.

The engine should model each position as:

- `S_public`: all public information visible to everyone;
- `S_private`: our hidden information;
- `B_opponents`: belief distributions over opponents' hidden information and likely intentions;
- `R`: rule set for the selected map/extension/player count;
- `t`: turn index / phase marker.

So the solver state is:

`X = (S_public, S_private, B_opponents, R, t)`

This means we should not start from a pure minimax engine. A more realistic foundation is:

- rule-based state transition model;
- belief update layer;
- action evaluator over sampled hidden states;
- empirical calibration from logged games.

## Representation of game state

For USA, the state should include at least:

### Public state

- claimed routes by player;
- remaining trains by player;
- visible face-up train cards;
- discard pile summary if known;
- deck size estimate or exact size if reconstructable;
- action history by turn;
- last-round trigger state;
- player order and current player.

### Our private state

- train cards in hand by color and locomotives;
- destination tickets in hand;
- tickets already effectively secured or at risk;
- optional internal plan tags such as "LA-NY backbone" or "north corridor pivot".

### Opponent belief state

For each opponent:

- posterior over train card color counts;
- posterior over destination ticket sets or ticket clusters;
- route intention scores by corridor;
- block/tempo aggressiveness estimate;
- likelihood they are racing long coast-to-coast lines;
- likelihood they are fishing for colors versus immediate claim.

## Action space

Available actions on a turn:

1. Draw face-up train card.
2. Draw blind train card.
3. Claim a route.
4. Draw destination tickets and choose which to keep.

Each action must be encoded with enough detail for simulation:

- exact card/color choice for draws;
- exact route and exact color payment pattern for claims;
- exact kept/rejected tickets when ticket draw happens in simulation.

## Objective function

The solver should optimize expected final standing, not only immediate points.

A practical utility function:

`U = w1 * P(win) + w2 * E(score_diff) + w3 * E(final_score)`

Recommended default priority:

- primary target: maximize `P(win)`;
- secondary target: maximize expected score margin;
- tertiary target: maximize raw score.

This matters because some locally profitable plays lose tempo or expose us to blocks.

## Decomposition of position strength

To evaluate a position, we need more than current score. A useful value decomposition is:

`V(X) = RouteValue + TicketValue + TempoValue + FlexibilityValue - RiskCost - BlockExposure`

Where:

- `RouteValue`: expected direct points from plausible future claims;
- `TicketValue`: expected net completion value of destination tickets;
- `TempoValue`: value of reaching important routes before opponents;
- `FlexibilityValue`: ability to pivot after uncertain draws/opponent actions;
- `RiskCost`: expected loss from dead tickets, stranded colors, or forced inefficiency;
- `BlockExposure`: probability-weighted cost of key corridors being taken first.

## Recommended engine architecture

### Layer 1: deterministic rules engine

Needs to answer:

- which actions are legal;
- how each action transforms the state;
- connectivity after route claims;
- route competition constraints for 2/3/4/5 players;
- scoring, longest route, endgame trigger.

This layer should be exact.

### Layer 2: inference engine

Needs to infer hidden information from observed actions.

Examples:

- if opponent repeatedly draws reds and oranges, western route plans become more likely;
- if opponent takes destination tickets midgame, their completion plan broadens but tempo dips;
- if opponent ignores an obvious claim window, some ticket families become less likely.

Recommended early approach:

- hand-crafted Bayesian updates;
- ticket clustering rather than full exact ticket-set enumeration;
- simple opponent archetypes as priors.

### Layer 3: candidate-plan generator

Instead of evaluating moves in isolation, generate plausible multi-turn plans such as:

- complete current main ticket spine;
- secure bottleneck before color completion;
- draw for a 6-length route setup;
- pivot to secondary ticket region;
- deny opponent corridor while preserving own completion odds.

This is important because many best moves are only best inside a plan.

### Layer 4: rollout evaluator

For each candidate action:

1. Sample hidden states from opponent beliefs.
2. Simulate plausible opponent responses.
3. Continue several plies with a fast policy.
4. Estimate utility.

This can start as shallow Monte Carlo with heuristic policies before moving toward stronger search.

## What "optimal" should mean here

For this project, "optimal action" should mean:

"The action with the highest estimated expected match utility under the current public state, our private information, and a calibrated model of hidden information and opponent behavior."

This is deliberately practical, not game-theoretically perfect.

## Mathematical roadmap

### Phase 1: exact state and scoring model

Deliverables:

- USA graph and route metadata;
- legal-action generator;
- score calculator;
- connectivity and longest-route helpers;
- replayable turn log format.

### Phase 2: static evaluation function

Deliverables:

- features for position quality;
- route/ticket completion estimator;
- bottleneck and block risk metrics;
- action ranking without deep simulation.

This is the first usable recommender.

### Phase 3: probabilistic opponent model

Deliverables:

- belief model for opponent hand colors;
- ticket-family priors/posteriors;
- intent inference from route claims and card pickups.

### Phase 4: simulation engine

Deliverables:

- stochastic forward model;
- opponent policy models;
- Monte Carlo action evaluation.

### Phase 5: data calibration

Deliverables:

- parser for recorded games;
- feature extraction pipeline;
- offline evaluation framework;
- parameter fitting from real games.

## Suggested feature set for the first evaluator

The first recommender can be built around these features:

- number of trains remaining;
- expected turns to complete each target route set;
- number of critical missing colors/cards;
- number of still-open paths for each ticket;
- ticket completion slack;
- exposure of single-point-of-failure corridors;
- value of contested 5/6-length routes;
- probability an opponent reaches a bottleneck first;
- marginal value of drawing cards versus claiming now;
- endgame pace estimate.

## Ticket modeling strategy

Exact inference over all possible ticket combinations can explode quickly. A more practical starting point:

1. Group USA tickets into corridor families and regional objectives.
2. Estimate opponent likelihoods over families, not exact sets.
3. Refine to exact ticket combinations only when the posterior narrows enough.

Example families:

- transcontinental;
- northwest to south;
- east coast mesh;
- central north-south;
- California/Texas pivots.

## Opponent modeling strategy

Start with interpretable archetypes:

- builder: pursues own tickets with low blocking frequency;
- blocker: willing to spend tempo to deny corridors;
- opportunist: switches plans aggressively based on draws;
- sprinter: accelerates endgame with short efficient claims.

Each archetype can define:

- route-priority weights;
- ticket-taking frequency;
- willingness to spend locomotives early;
- probability of defensive blocking;
- tendency to hold versus spend sets.

These priors can later be personalized from logs.

## Data strategy

Since real match records are available, we should use them early.

Useful data sources:

- manual game logs;
- online match replays;
- self-play later, only after the simulator becomes credible.

For each turn, we ideally want:

- current public state;
- acting player;
- chosen action;
- eventual game outcome.

This lets us learn:

- action value approximations;
- better opponent priors;
- calibration of heuristic weights.

## Evaluation metrics

We should judge the recommender by:

- win rate against baseline heuristics;
- average score difference;
- ticket completion rate;
- calibration of predicted action quality;
- robustness across 2/3/4/5 players;
- robustness across opponent archetypes.

## Recommended implementation order

1. Formalize USA board data.
2. Define a serializable game-state schema.
3. Build exact legal move and transition logic.
4. Add a heuristic static evaluator.
5. Add log/replay ingestion.
6. Add belief updates from observed actions.
7. Add Monte Carlo lookahead.
8. Build the web UI on top of the engine.

## Best near-term next step

The most productive next artifact is not the UI. It is:

`GameState + rules engine + action log schema`

Once that exists, everything else becomes testable:

- evaluator;
- replay analysis;
- recommendation engine;
- browser UI.

## Proposed immediate backlog

1. Encode the USA map as structured data.
2. Define TypeScript types for game state, actions, and rules.
3. Implement scoring and route-claim legality.
4. Add a replay format for importing real games.
5. Build the first heuristic recommender.
