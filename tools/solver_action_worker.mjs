import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  USA_BOARD,
  blendHeuristicAndLearnedScores,
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

const modelCache = new Map();

const loadModel = (modelPath) => {
  const resolvedPath = path.resolve(process.cwd(), modelPath);
  const cachedModel = modelCache.get(resolvedPath);
  if (cachedModel) {
    return cachedModel;
  }

  const model = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  modelCache.set(resolvedPath, model);
  return model;
};

const scoreAlternatives = (evaluation, payload) => {
  if (!payload.policyModelPath) {
    return [...evaluation.alternatives];
  }

  const model = loadModel(payload.policyModelPath);
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

  return evaluation.alternatives
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
};

const handleRecommend = (payload) => {
  const evaluation = recommendActions(payload.gameState, USA_BOARD);
  const rankedAlternatives = scoreAlternatives(evaluation, payload);
  const alternatives = rankedAlternatives.slice(0, 12).map((entry) => ({
    utilityScore: entry.utilityScore,
    confidence: entry.confidence,
    rationale: entry.rationale,
    action: entry.action,
    actionId: entry.actionId,
    featureBreakdown: entry.featureBreakdown
  }));

  return {
    topAction: alternatives[0]?.action ?? null,
    topActionId: alternatives[0]?.actionId ?? null,
    topUtilityScore: alternatives[0]?.utilityScore ?? null,
    topConfidence: alternatives[0]?.confidence ?? null,
    topRationale: alternatives[0]?.rationale ?? [],
    alternatives
  };
};

const handleRoutes = () => USA_BOARD.routes;

const handleRequest = (request) => {
  switch (request.type) {
    case "recommend":
      return handleRecommend(request.payload ?? {});
    case "get-usa-routes":
      return handleRoutes();
    default:
      throw new Error(`Unknown worker request type: ${String(request.type)}`);
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: `Failed to parse request JSON: ${error instanceof Error ? error.message : String(error)}`
      })}\n`
    );
    return;
  }

  try {
    const payload = handleRequest(request);
    process.stdout.write(`${JSON.stringify({ ok: true, payload })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.stack ?? error.message : String(error)
      })}\n`
    );
  }
});
