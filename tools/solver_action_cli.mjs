import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  USA_BOARD,
  blendHeuristicAndLearnedScores,
  rankColorPriorities,
  recommendActions,
  scoreActionRecommendationWithModel
} from "../dist/browser.js";

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const standardDeviation = (values, valueMean) => {
  if (values.length <= 1) {
    return 1;
  }

  const variance =
    values.reduce((sum, value) => sum + (value - valueMean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(variance, 1e-9));
};

const normalizeToReferenceRange = (scores, referenceScores) => {
  if (scores.length === 0) {
    return [];
  }

  const scoreMean = mean(scores);
  const scoreStd = standardDeviation(scores, scoreMean);
  const referenceMean = mean(referenceScores);
  const referenceStd = standardDeviation(referenceScores, referenceMean);

  return scores.map((score) => referenceMean + ((score - scoreMean) / scoreStd) * referenceStd);
};

const readInput = async () => {
  if (process.argv[2]) {
    return fs.readFileSync(process.argv[2], "utf8");
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const raw = (await readInput()).trim();
  if (!raw) {
    throw new Error("Expected JSON payload on stdin or as a file path argument.");
  }

  const payload = JSON.parse(raw);
  const evaluation = recommendActions(payload.gameState, USA_BOARD);
  let rankedAlternatives = [...evaluation.alternatives];

  if (payload.policyModelPath) {
    const modelPath = path.resolve(process.cwd(), payload.policyModelPath);
    const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
    const heuristicWeight = Number(payload.heuristicWeight ?? 0.55);
    const learnedWeight = Number(payload.learnedWeight ?? 0.45);
    const context = {
      phase: payload.gameState.publicState.phase,
      playerCount: payload.gameState.rules.playerCount,
      knownHand: payload.gameState.ourState.hand,
      knownTicketCount: payload.gameState.ourState.ticketIds.length
    };

    const rawLearnedScores = evaluation.alternatives.map((entry) =>
      scoreActionRecommendationWithModel(model, entry, context)
    );
    const calibratedLearnedScores =
      model.kind === "phase-policy-bundle" || model.kind === "pairwise-linear"
        ? normalizeToReferenceRange(
            rawLearnedScores,
            evaluation.alternatives.map((entry) => entry.utilityScore)
          )
        : rawLearnedScores;

    rankedAlternatives = evaluation.alternatives
      .map((entry, index) => {
        const learnedUtilityScore = calibratedLearnedScores[index] ?? rawLearnedScores[index] ?? 0;
        const blendedUtilityScore = blendHeuristicAndLearnedScores(
          entry.utilityScore,
          learnedUtilityScore,
          heuristicWeight,
          learnedWeight
        );

        return {
          ...entry,
          utilityScore: blendedUtilityScore,
          rationale: [
            ...entry.rationale,
            `learned reranker estimate ${learnedUtilityScore.toFixed(2)}`,
            `blended utility ${blendedUtilityScore.toFixed(2)}`
          ]
        };
      })
      .sort((left, right) => right.utilityScore - left.utilityScore);
  }

  const alternatives = rankedAlternatives.map((entry) => ({
    utilityScore: entry.utilityScore,
    confidence: entry.confidence,
    rationale: entry.rationale,
    action: entry.action,
    actionId: entry.actionId,
    featureBreakdown: entry.featureBreakdown
  }));
  const colorPriorities = rankColorPriorities(payload.gameState, USA_BOARD);

  process.stdout.write(
    JSON.stringify(
      {
        topAction: alternatives[0]?.action ?? null,
        topActionId: alternatives[0]?.actionId ?? null,
        topUtilityScore: alternatives[0]?.utilityScore ?? null,
        topConfidence: alternatives[0]?.confidence ?? null,
        topRationale: alternatives[0]?.rationale ?? [],
        alternatives,
        colorPriorities
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
