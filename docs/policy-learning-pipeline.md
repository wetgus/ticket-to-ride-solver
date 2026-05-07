# Policy Learning Pipeline

## Goal

Move from a hand-tuned heuristic recommender to a solver that improves from played and simulated games while still keeping the current engine structure:

`state -> legal actions -> action features -> ranked actions`

The learned layer should help answer:

- which action is most likely to improve winning chances;
- when to draw versus claim;
- when to race tempo versus preserve flexibility;
- when to draw tickets and how risky that is in the current game clock.

## Practical target

The first learned component should be a **reranker**, not a full end-to-end neural agent.

Recommended shape:

1. Use the current engine to enumerate legal actions.
2. For each legal action, compute a feature vector.
3. Train a model to predict action quality.
4. Use the model score to rerank or blend with the heuristic score.

This keeps the project interpretable and makes debugging much easier than jumping directly into reinforcement learning.

## Why not train directly on human actions

Human logs are useful, but they are not an oracle.

They should be used for:

- realistic state distributions;
- calibration of hidden-information priors;
- sanity checking action frequencies;
- replay-based evaluation.

They should **not** be treated as the definition of optimal play.

## First training loop

### Step 1: generate supervised rows

For every decision point in a replay or simulated game:

- snapshot the state before the move;
- enumerate legal actions;
- compute action features for each legal action;
- store the chosen action;
- store the final game outcome.

Each row should answer:

- what was the position;
- what was one candidate action;
- what happened by the end of the game.

### Step 2: train a value/ranking model

Recommended early targets:

- `win_target`: 1 if the acting player won the game, else 0
- `placement_target`: normalized finishing place
- `score_delta_target`: final score minus table average

Recommended early models:

- logistic regression
- gradient boosted trees
- small MLP

Strong recommendation: start with **gradient boosted trees** or another tabular learner before trying a neural policy. Ticket to Ride produces structured, medium-sized tabular features very naturally.

### Better second iteration

After the first global chosen-row regressor, the next upgrade should be:

1. split training by decision family;
2. train a **pairwise ranking** model inside each decision point.

Recommended first split:

- `ticket-keep`
- `main-turn`

Recommended pairwise setup:

- for each decision point, compare the chosen action against every alternative;
- train on feature deltas `chosen - alternative`;
- use the learned preference vector to rerank candidate actions.

This aligns much better with the real solver task than asking one global regressor to predict the final result from a single chosen action in isolation.

### Step 3: blend with the heuristic solver

Early deployment formula:

`final_score = alpha * heuristic_score + beta * learned_score`

This is safer than replacing the heuristic policy all at once.

### Step 4: benchmark

After every training batch:

1. freeze the new model;
2. run benchmark matches against baseline agents;
3. compare against the previous solver version;
4. only keep the new model if benchmark metrics improve.

## Recommended data sources

### 1. Replay logs

Use for:

- state realism
- public/private state reconstruction
- opponent color-frequency priors
- endgame timing statistics

### 2. Solver self-play

Use for:

- controlled data generation
- policy iteration
- discovering failure modes against known opponents

### 3. Cross-play against baseline agents

Use for:

- objective progress tracking
- regression detection
- measuring whether training improves actual match outcomes

## Dataset design

Each training row should represent a single candidate action from a single state.

Suggested fields:

- `gameId`
- `turnIndex`
- `playerId`
- `phase`
- `playerCount`
- `variant`
- `candidateAction`
- `candidateActionId`
- `candidateFeatures`
- `heuristicUtilityScore`
- `wasChosen`
- `finalScore`
- `finalPlace`
- `wonGame`
- `ticketsCompleted`
- `longestRouteWon`

This structure supports both:

- supervised reranking
- offline counterfactual analysis

## Feature groups

The current engine already contains many of these implicitly. We should make them explicit.

### Position features

- current score
- score gap to leader
- trains remaining
- hand size
- face-up pool summary
- draw pile estimate
- discard summary
- endgame trigger pressure

### Ticket features

- number of active tickets
- expected ticket value
- completion probabilities
- distance-to-complete lower bounds
- bottleneck route count

### Action-local features

- immediate route points
- ticket progress delta
- route urgency secured
- route urgency exposed if skipped
- longest-route delta
- points per train
- locomotives spent
- color efficiency

### Opponent-pressure features

- known visible-color lower bounds
- contested corridor intensity
- opponent reply risk
- inferred ticket-family overlap

## Training cadence

Do not retrain after every single game.

Recommended cadence:

- small experiments: every `25-50` self-play games
- more stable training: every `100-500` games

This reduces noise and makes A/B comparison much cleaner.

## Evaluation metrics

Primary metrics:

- win rate
- average placement
- average score

Secondary metrics:

- ticket completion rate
- longest route rate
- average dead-ticket loss
- claim-vs-draw decision quality in benchmark traces

## Reinforcement learning path

Once the reranker is stable, we can move to a more RL-like loop:

1. solver plays self-play games;
2. collect `(state, action, outcome)` tuples;
3. fit updated action-value model;
4. use the updated model in the next generation of self-play.

This is a practical policy-iteration loop, even if we never build a large neural network.

## Where genetic algorithms fit

Genetic algorithms are not the default best tool for the first learned layer, but they are relevant.

They are most useful here for:

- tuning heuristic weights;
- evolving small policy parameter sets;
- evolving opponent archetype priors;
- searching over action-score blending coefficients.

They are less attractive as the main learning mechanism for the whole solver because:

- they are data-inefficient compared with supervised learning on replay/self-play rows;
- they require many full-game evaluations;
- they make credit assignment harder at the action level.

### Recommended use of genetic algorithms in this project

Use GA as a **meta-optimizer** over a compact parameter vector, for example:

- route urgency weights;
- endgame pressure weights;
- draw-ticket penalty weights;
- claim-vs-draw blending constants.

That gives a concrete and useful role:

`heuristic solver + GA-tuned weights + supervised reranker`

### Not recommended as the first main approach

Do not start with:

- evolving full neural policies from scratch;
- evolving huge rule sets through mutation only;
- using GA instead of having an action-level dataset.

That would be slower and much harder to debug than the reranker-first approach.

## Recommended implementation order

1. Add stable training-row schema.
2. Export self-play and replay rows into a unified corpus.
3. Train a first tabular reranker.
4. Benchmark against OSA/LRA/Hungry/Path baselines.
5. Add GA-based tuning for heuristic weights.
6. Add iterative self-play policy improvement.

## Near-term milestone

The next concrete milestone should be:

**Collect benchmark self-play traces and export candidate-action training rows from them.**

That is the first point where the learning loop becomes real.
