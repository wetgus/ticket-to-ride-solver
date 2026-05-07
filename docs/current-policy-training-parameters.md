# Current Policy Training Parameters

## What is currently being trained

The current learned layer is a **phase-split pairwise linear reranker**.

Current trained bundle:

- `ticket-keep`
- `main-turn`

The model compares:

- the action that was chosen in a decision point
- against each alternative action from the same decision point

It learns a linear preference function over feature deltas:

`chosen_features - alternative_features`

## Current trainable feature set

These features are defined in:

- [src/training/feature-vector.ts](../src/training/feature-vector.ts)

Current learned feature list:

1. `heuristicUtilityScore`
2. `heuristicConfidence`
3. `expectedFinalScore`
4. `winProbabilityEstimate`
5. `scoreDiffEstimate`
6. `routeValue`
7. `ticketValue`
8. `tempoValue`
9. `flexibilityValue`
10. `riskCost`
11. `blockExposure`
12. `trainsRemainingPressure`
13. `playerCount`
14. `knownHandSize`
15. `knownLocomotiveCount`
16. `knownTicketCount`
17. `actionClaimRoute`
18. `actionDrawFaceUp`
19. `actionDrawBlind`
20. `actionDrawTickets`
21. `actionKeepTickets`
22. `claimUsesLocomotives`
23. `claimRouteLength`
24. `claimColorCards`
25. `keepTicketCount`
26. `drawFaceUpLocomotive`
27. `drawFaceUpDemandColor`
28. `knownRed`
29. `knownBlue`
30. `knownGreen`
31. `knownYellow`
32. `knownBlack`
33. `knownWhite`
34. `knownOrange`
35. `knownPink`
36. `knownLocomotive`

Phase indicator features still exist in the raw feature vector, but they are no longer part of the learned feature set because the model is already split by phase.

## Parameters that are learned automatically

For each phase bucket, the model learns:

- one weight per feature
- one bias term

Current model artifact:

- [artifacts/policy-phase-pairwise-v1.json](../artifacts/policy-phase-pairwise-v1.json)

## Parameters that are still manual

These are **not** currently learned from the dataset. They are still hand-tuned:

1. Heuristic scoring logic in:
   - [src/engine/recommendations.ts](../src/engine/recommendations.ts)

2. Blend weights between heuristic and learned score:
   - `heuristicWeight`
   - `learnedWeight`

3. Pairwise trainer hyperparameters in:
   - [src/training/pairwise-reranker.ts](../src/training/pairwise-reranker.ts)

Current defaults:

- `epochs = 900`
- `learningRate = 0.04`
- `l2Penalty = 0.0015`
- `validationSplit = 0.2`

## What "manual add/remove" means right now

The safest current workflow is:

1. Add or remove features from `POLICY_FEATURE_NAMES`
2. Update the corresponding feature-population logic in `buildPolicyFeatureVector(...)`
3. Retrain the phase-pairwise bundle
4. Benchmark against cross-play

## Reasonable first candidates to remove temporarily

These are plausible future ablation candidates if we want to simplify the model further:

- `playerCount`
- individual `known<Color>` features

Why:

- some may be redundant because phase is already split externally
- some may be weak or noisy in 4-player-only corpora

## Reasonable first candidates to add

These are plausible next features if we want to expand the model:

1. `currentScore`
2. `scoreGapToLeader`
3. `trainsRemaining`
4. `opponentClockPressure`
5. `availableSixLengthClaimCount`
6. `urgentCorridorCount`
7. `ticketCompletionSlackMin`
8. `ticketCompletionSlackMean`
9. `canTriggerEndgameSoon`
10. `drawImprovesTopClaim`

## Recommended next manual tuning loop

1. Keep the phase split
2. Change only a small number of features at once
3. Retrain on:
   - cross-play corpus
   - self-play corpus
4. Benchmark on cross-play
5. Keep the change only if benchmark metrics improve

That keeps the process empirical and prevents the feature set from drifting into theory without evidence.
