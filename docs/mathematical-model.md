# Mathematical Model for the Recommendation Engine

## Scope

This document defines the first practical mathematical model for a Ticket to Ride solver on the standard USA map.

The aim is not perfect equilibrium play. The aim is a strong decision model that works under:

- hidden information;
- stochastic draws;
- multiple opponents;
- imperfect inference;
- practical calibration from real games.

## 1. Formal state

At turn `t`, define state:

`X_t = (P_t, H_t, B_t, G, N, t)`

Where:

- `P_t`: public state;
- `H_t`: our hidden state;
- `B_t`: belief state over opponents and unseen cards;
- `G`: USA board graph and ticket catalog;
- `N`: player/rule configuration.

### 1.1 Public state `P_t`

`P_t` includes:

- claimed routes `C_t`;
- remaining trains per player `T_t`;
- visible face-up cards `F_t`;
- action history `A_1 ... A_t`;
- known score state `Score_t`;
- last-round flag `L_t`;
- turn order / current actor `Turn_t`.

### 1.2 Our hidden state `H_t`

`H_t` includes:

- train-card multiset in hand;
- destination tickets in hand;
- optional internal plan label set.

### 1.3 Belief state `B_t`

`B_t` includes distributions over:

- opponents' train-card color counts;
- opponents' destination ticket families;
- unseen deck composition;
- opponent style/archetype.

## 2. Board model

Represent the USA map as an undirected multigraph:

`G = (V, E)`

Where:

- `V`: cities;
- `E`: routes.

Each route `e in E` has:

- endpoints `(u, v)`;
- length `len(e)`;
- color requirement `col(e)` or gray;
- point value `pts(e)`;
- owner `owner(e)` or null;
- double-route metadata;
- regional tags for strategy/inference.

## 3. Action model

Legal actions:

`A(X_t) = A_draw_faceup U A_draw_blind U A_claim U A_ticket_draw`

An action is one of:

- `draw_faceup(c)`;
- `draw_blind`;
- `claim(e, payment_pattern)`;
- `draw_tickets`;
- `keep_tickets(S)` after ticket draw.

Each action induces a transition kernel:

`X_(t+1) ~ T(X_t, a_t)`

Because draws and hidden information are stochastic, `T` is probabilistic.

## 4. Objective

The engine should rank actions by expected match utility:

`Q(X_t, a) = E[U(final_state) | X_t, a]`

The first practical final-state utility:

`U = alpha * I(win) + beta * score_diff + gamma * final_score`

Where:

- `I(win)` is 1 if we finish first, else 0;
- `score_diff` is our score minus best opponent score;
- `final_score` is our raw score.

Recommended ordering of importance:

- `alpha` dominant;
- `beta` moderate;
- `gamma` small.

## 5. Static value approximation

Before we have deep simulation, estimate:

`V(X_t) ~= sum_i w_i * phi_i(X_t)`

Where `phi_i` are hand-crafted features.

### 5.1 Core feature families

#### Ticket completion features

- estimated completion probability for each owned ticket;
- expected net ticket value;
- minimum trains required for completion;
- number of viable path alternatives;
- bottleneck dependency count.

#### Route-building features

- expected direct points still accessible;
- availability of high-efficiency routes;
- value of immediately claimable routes;
- cost-to-finish backbone corridors.

#### Tempo features

- expected number of turns to secure a plan;
- probability a contested route is lost before next access;
- remaining-train pace relative to opponents.

#### Flexibility features

- color diversity in hand;
- wild-card liquidity;
- number of productive next-turn actions;
- resilience if one corridor is blocked.

#### Risk features

- dead-card accumulation risk;
- dead-ticket risk;
- block exposure;
- forced-detour penalty.

## 6. Ticket completion model

Let each ticket be `(s, d, value)`.

For a player `i`, define a route-cost function over the residual graph:

`cost_i(path) = cards_needed(path) + lambda * contested(path) + mu * detour_penalty(path)`

Then estimated completion cost for ticket `k`:

`C_i(k) = min_(path: s->d) cost_i(path)`

We can turn that into completion probability with a calibrated logistic form:

`Pr_i(complete k) = sigma(b0 + b1 * slack_i(k) - b2 * C_i(k) - b3 * exposure_i(k))`

Where:

- `slack_i(k)` measures how many alternative realizations remain;
- `exposure_i(k)` measures dependency on corridors likely to be taken first.

Expected ticket value:

`EV_i(k) = Pr_i(complete k) * value - (1 - Pr_i(complete k)) * value`

So:

`EV_i(k) = (2 * Pr_i(complete k) - 1) * value`

For multiple tickets:

`TicketValue = sum_k EV_i(k) + synergy_bonus - overlap_risk`

## 7. Contested route model

For a critical route `e`, define:

`Pr(lose e before us) = f(turn_distance, opponent_interest, card_readiness, seat_order)`

A first simple model:

`RISK_e = sigma(c0 + c1 * delta_turns + c2 * inferred_interest + c3 * claimability_gap + c4 * seat_penalty)`

Where:

- `delta_turns`: how many actions until we can claim it;
- `inferred_interest`: belief-weighted opponent need for `e`;
- `claimability_gap`: missing cards/trains before we can claim;
- `seat_penalty`: disadvantage from move order.

This gives a principled urgency score for "claim now vs draw first".

## 8. Opponent belief model

We cannot observe hidden hands or tickets directly, so maintain:

`B_t = Π_j B_t^(j)`

For each opponent `j`:

`B_t^(j) = (CardBelief_j, TicketBelief_j, ArchetypeBelief_j)`

### 8.1 Train-card belief

Track posterior distribution over card counts by color.

Update sources:

- visible face-up draws;
- blind draws;
- route claims and payment colors;
- ticket-draw actions;
- passes in claim windows.

Visible draw example:

If opponent takes a red face-up card, increase posterior mass on plans requiring red-linked corridors and increment known red count lower bound.

### 8.2 Ticket belief

Let ticket families be latent variable `Z_j`.

Examples of families:

- west-east transcontinental;
- north-south long haul;
- east-cluster local mesh;
- west/southwest network;
- central connector plans.

We update by Bayes:

`Pr(Z_j | history) proportional Pr(history | Z_j) * Pr(Z_j)`

This is much more tractable than exact enumeration over all ticket subsets.

### 8.3 Archetype belief

Let opponent style `Y_j` be one of:

- builder;
- blocker;
- opportunist;
- sprinter.

Then:

`Pr(Y_j | history) proportional Pr(history | Y_j) * Pr(Y_j)`

This affects rollout policy and route-risk estimates.

## 9. Recommendation as expectation under hidden information

The action score is:

`Q(X_t, a) = E_(Omega ~ B_t)[ E[U | X_t, a, Omega] ]`

Where `Omega` is a sampled completion of hidden state:

- unseen deck order;
- opponents' hands;
- opponents' tickets;
- opponent styles.

In practice:

`Q_hat(X_t, a) = (1 / M) * sum_(m=1..M) rollout(X_t, a, Omega_m)`

This is the core Monte Carlo estimator.

## 10. Practical rollout design

For each candidate action:

1. Sample hidden world `Omega_m` from `B_t`.
2. Apply action `a`.
3. Simulate `h` future plies with lightweight policies.
4. Evaluate terminal or truncated state with `V`.

Then:

`rollout = immediate_reward + discounted_future_value`

Possible form:

`rollout = r_0 + eta * V(X_(t+h))`

Where `eta` is close to 1 because Ticket to Ride has long-horizon value.

## 11. Plan-based recommendation

Pure one-step ranking can miss strategic commitments. So define a latent plan variable `Pi`.

Examples:

- secure southern transcontinental backbone;
- complete central ticket cluster first;
- rush contested 6-route;
- defensive block then pivot.

Then the effective score of action `a` is:

`Q*(X_t, a) = max_(Pi) Pr(Pi | X_t) * Fit(a, Pi) * EV(Pi | X_t)`

Interpretation:

- `Pr(Pi | X_t)`: how plausible the plan is now;
- `Fit(a, Pi)`: how well action supports the plan;
- `EV(Pi | X_t)`: expected utility if we pursue it.

This makes the engine feel more human and less greedy.

## 12. Endgame model

When any player approaches the last-round trigger, priorities change sharply.

Important endgame features:

- turns remaining before game end;
- points-per-train efficiency;
- number of tickets finishable before shutdown;
- value of longest route race;
- penalty risk from unresolved tickets.

Then utility shifts from open-ended plan growth to short-horizon conversion:

`V_end(X_t) = score_conversion + ticket_lock_in - unfinished_penalty + longest_route_ev`

## 13. Learning from real logs

We should calibrate the model, not freeze it by hand forever.

### 13.1 Supervised targets

From logged positions:

- predict chosen human action;
- predict eventual win probability;
- predict ticket completion outcomes;
- predict route contest outcomes.

### 13.2 Learnable parameters

- feature weights `w_i`;
- logistic coefficients for ticket completion;
- route-loss risk coefficients;
- archetype priors;
- policy parameters for simulated opponents.

### 13.3 Evaluation

Offline:

- log-likelihood of observed actions;
- Brier score / calibration for predicted win rates;
- ranking quality for known strong actions.

Online:

- win rate against fixed baselines;
- regret against stronger engine versions.

## 14. First useful simplified model

Version 1 does not need full posterior exactness.

The first strong practical recommender can use:

1. Exact rules engine.
2. Exact public-state tracking.
3. Heuristic estimate of our ticket completion graph.
4. Simple posterior over opponent route families.
5. Urgency model for contested bottlenecks.
6. One-step or shallow two-step Monte Carlo evaluation.

This is likely enough to produce recommendations that already feel strategic.

## 15. Research hypotheses to test with logs

Good early hypotheses:

1. Claiming contested bottlenecks earlier improves win rate more than greedy point maximization.
2. Ticket-family inference from early card/color behavior is predictive enough to guide blocking.
3. Static ticket-completion slack is one of the strongest features for action quality.
4. Endgame errors mostly come from mis-estimating remaining effective turns.
5. A small number of interpretable opponent archetypes outperforms uniform-opponent assumptions.

## 16. Immediate implementation implications

The mathematical model suggests these first code modules:

- `board-data`;
- `game-state`;
- `rules-engine`;
- `graph-analysis`;
- `feature-extractor`;
- `belief-engine`;
- `action-evaluator`;
- `replay-parser`.

## 17. Definition of success for version 1

Version 1 is successful if:

- it reconstructs and validates legal game states;
- it ranks legal actions plausibly in real midgame scenarios;
- it explains recommendations in human terms;
- it improves over simple baseline heuristics on replay tests.

