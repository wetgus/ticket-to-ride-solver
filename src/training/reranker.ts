import type { ActionRecommendation } from "../model/evaluation.js";
import type { TrainingCandidateActionRow } from "./types.js";
import type {
  PairwisePhasePolicyModel,
  PhasePolicyBundleModel
} from "./pairwise-reranker.js";
import {
  LEARNED_POLICY_FEATURE_NAMES,
  POLICY_FEATURE_NAMES,
  buildPolicyFeatureVectorFromRecommendation,
  buildPolicyFeatureVectorFromRow,
  type PolicyFeatureContext,
  vectorToFeatureArray
} from "./feature-vector.js";
import {
  scoreActionRecommendationWithPairwiseModel,
  scoreActionRecommendationWithPhaseBundle
} from "./pairwise-reranker.js";
import { computeTrainingTarget } from "./targets.js";

export interface PolicyRerankerModel {
  version: 1;
  featureNames: string[];
  featureMeans: number[];
  featureScales: number[];
  weights: number[];
  bias: number;
  targetMean: number;
  targetScale: number;
  trainingRowCount: number;
  metrics: {
    trainRmse: number;
    validationRmse: number;
    trainMae: number;
    validationMae: number;
  };
}

export type AnyPolicyModel =
  | PolicyRerankerModel
  | PairwisePhasePolicyModel
  | PhasePolicyBundleModel;

export interface PolicyTrainingExample {
  features: number[];
  target: number;
}

export interface PolicyTrainingOptions {
  epochs?: number;
  learningRate?: number;
  l2Penalty?: number;
  validationSplit?: number;
}

const DEFAULT_OPTIONS: Required<PolicyTrainingOptions> = {
  epochs: 1200,
  learningRate: 0.015,
  l2Penalty: 0.0008,
  validationSplit: 0.2
};

const hashText = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const standardDeviation = (values: number[], valueMean: number): number => {
  if (values.length <= 1) {
    return 1;
  }

  const variance =
    values.reduce((sum, value) => sum + (value - valueMean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(variance, 1e-9));
};

const createFeatureMatrix = (examples: PolicyTrainingExample[]): number[][] =>
  examples.map((example) => example.features);

const normalizeMatrix = (
  matrix: number[][]
): {
  normalized: number[][];
  means: number[];
  scales: number[];
} => {
  const columnCount = matrix[0]?.length ?? 0;
  const means: number[] = [];
  const scales: number[] = [];

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const values = matrix.map((row) => row[columnIndex] ?? 0);
    const valueMean = mean(values);
    const valueScale = standardDeviation(values, valueMean);
    means.push(valueMean);
    scales.push(valueScale);
  }

  return {
    means,
    scales,
    normalized: matrix.map((row) =>
      row.map((value, columnIndex) => (value - means[columnIndex]!) / scales[columnIndex]!)
    )
  };
};

const normalizeTarget = (targets: number[]): { normalized: number[]; mean: number; scale: number } => {
  const targetMean = mean(targets);
  const targetScale = standardDeviation(targets, targetMean);
  return {
    mean: targetMean,
    scale: targetScale,
    normalized: targets.map((value) => (value - targetMean) / targetScale)
  };
};

const dot = (left: number[], right: number[]): number =>
  left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

const denormalizeTarget = (value: number, meanValue: number, scaleValue: number): number =>
  value * scaleValue + meanValue;

const predictNormalized = (features: number[], weights: number[], bias: number): number =>
  dot(features, weights) + bias;

const clampMagnitude = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

const computeRegressionMetrics = (
  normalizedFeatures: number[][],
  normalizedTargets: number[],
  weights: number[],
  bias: number,
  targetMeanValue: number,
  targetScaleValue: number
) => {
  if (normalizedFeatures.length === 0) {
    return {
      rmse: 0,
      mae: 0
    };
  }

  const errors = normalizedFeatures.map((features, index) => {
    const predicted = denormalizeTarget(
      predictNormalized(features, weights, bias),
      targetMeanValue,
      targetScaleValue
    );
    const observed = denormalizeTarget(
      normalizedTargets[index] ?? 0,
      targetMeanValue,
      targetScaleValue
    );
    return predicted - observed;
  });

  return {
    rmse: Math.sqrt(mean(errors.map((error) => error * error))),
    mae: mean(errors.map((error) => Math.abs(error)))
  };
};

const trainLinearRegressor = (
  normalizedFeatures: number[][],
  normalizedTargets: number[],
  options: Required<PolicyTrainingOptions>
): { weights: number[]; bias: number } => {
  const featureCount = normalizedFeatures[0]?.length ?? 0;
  const weights = Array.from({ length: featureCount }, () => 0);
  let bias = 0;
  const rowCount = Math.max(1, normalizedFeatures.length);

  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    const weightGradients = Array.from({ length: featureCount }, () => 0);
    let biasGradient = 0;

    for (let rowIndex = 0; rowIndex < normalizedFeatures.length; rowIndex += 1) {
      const features = normalizedFeatures[rowIndex]!;
      const target = normalizedTargets[rowIndex] ?? 0;
      const prediction = predictNormalized(features, weights, bias);
      const error = prediction - target;

      biasGradient += error;
      for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
        weightGradients[featureIndex] =
          weightGradients[featureIndex]! + error * (features[featureIndex] ?? 0);
      }
    }

    for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
      const averageGradient =
        weightGradients[featureIndex]! / rowCount + options.l2Penalty * weights[featureIndex]!;
      weights[featureIndex] =
        weights[featureIndex]! - options.learningRate * clampMagnitude(averageGradient, 10);
    }

    bias -= options.learningRate * clampMagnitude(biasGradient / rowCount, 10);

    if (!Number.isFinite(bias) || weights.some((weight) => !Number.isFinite(weight))) {
      throw new Error(`Policy reranker diverged numerically at epoch ${epoch + 1}.`);
    }
  }

  return { weights, bias };
};

export const extractChosenRowExamples = (
  rows: TrainingCandidateActionRow[]
): Array<{ features: number[]; target: number; splitKey: string }> =>
  rows
    .filter(
      (row) =>
        row.wasChosen &&
        row.finalScore !== undefined &&
        row.finalPlace !== undefined &&
        row.wonGame !== undefined
    )
    .map((row) => ({
      features: vectorToFeatureArray(buildPolicyFeatureVectorFromRow(row), LEARNED_POLICY_FEATURE_NAMES),
      target: computeTrainingTarget(row),
      splitKey: `${row.gameId}:${row.playerId}`
    }));

export const trainPolicyReranker = (
  rows: TrainingCandidateActionRow[],
  providedOptions: PolicyTrainingOptions = {}
): PolicyRerankerModel => {
  const options = {
    ...DEFAULT_OPTIONS,
    ...providedOptions
  };
  const examples = extractChosenRowExamples(rows);

  if (examples.length < 4) {
    throw new Error("Need at least 4 chosen decision rows to train the policy reranker.");
  }

  const trainingExamples: PolicyTrainingExample[] = [];
  const validationExamples: PolicyTrainingExample[] = [];

  for (const example of examples) {
    const bucket = (hashText(example.splitKey) % 1000) / 1000;
    if (bucket < options.validationSplit) {
      validationExamples.push(example);
    } else {
      trainingExamples.push(example);
    }
  }

  if (trainingExamples.length === 0 || validationExamples.length === 0) {
    const fallbackCut = Math.max(1, Math.floor(examples.length * (1 - options.validationSplit)));
    trainingExamples.push(...examples.slice(0, fallbackCut));
    validationExamples.push(...examples.slice(fallbackCut));
  }

  const trainingMatrix = createFeatureMatrix(trainingExamples);
  const { normalized: normalizedTrainingMatrix, means, scales } = normalizeMatrix(trainingMatrix);
  const targetNormalization = normalizeTarget(trainingExamples.map((example) => example.target));

  const { weights, bias } = trainLinearRegressor(
    normalizedTrainingMatrix,
    targetNormalization.normalized,
    options
  );

  const validationMatrixRaw = createFeatureMatrix(validationExamples);
  const normalizedValidationMatrix = validationMatrixRaw.map((row) =>
    row.map((value, columnIndex) => (value - means[columnIndex]!) / scales[columnIndex]!)
  );
  const normalizedValidationTargets = validationExamples.map(
    (example) => (example.target - targetNormalization.mean) / targetNormalization.scale
  );

  const trainMetrics = computeRegressionMetrics(
    normalizedTrainingMatrix,
    targetNormalization.normalized,
    weights,
    bias,
    targetNormalization.mean,
    targetNormalization.scale
  );
  const validationMetrics = computeRegressionMetrics(
    normalizedValidationMatrix,
    normalizedValidationTargets,
    weights,
    bias,
    targetNormalization.mean,
    targetNormalization.scale
  );

  return {
    version: 1,
    featureNames: [...LEARNED_POLICY_FEATURE_NAMES],
    featureMeans: means,
    featureScales: scales,
    weights,
    bias,
    targetMean: targetNormalization.mean,
    targetScale: targetNormalization.scale,
    trainingRowCount: examples.length,
    metrics: {
      trainRmse: trainMetrics.rmse,
      validationRmse: validationMetrics.rmse,
      trainMae: trainMetrics.mae,
      validationMae: validationMetrics.mae
    }
  };
};

export const scorePolicyFeatureArray = (
  model: PolicyRerankerModel,
  features: number[]
): number => {
  const normalized = features.map(
    (value, index) => (value - (model.featureMeans[index] ?? 0)) / (model.featureScales[index] ?? 1)
  );

  return denormalizeTarget(
    predictNormalized(normalized, model.weights, model.bias),
    model.targetMean,
    model.targetScale
  );
};

export const scoreActionRecommendationWithModel = (
  model: AnyPolicyModel,
  recommendation: ActionRecommendation,
  context: PolicyFeatureContext
): number => {
  if ("kind" in model && model.kind === "phase-policy-bundle") {
    return scoreActionRecommendationWithPhaseBundle(model, recommendation, context);
  }

  if ("kind" in model && model.kind === "pairwise-linear") {
    return scoreActionRecommendationWithPairwiseModel(model, recommendation, context);
  }

  const vector = buildPolicyFeatureVectorFromRecommendation(recommendation, context);
  const features = vectorToFeatureArray(
    vector,
    model.featureNames as Array<(typeof POLICY_FEATURE_NAMES)[number]>
  );
  return scorePolicyFeatureArray(model, features);
};

export const blendHeuristicAndLearnedScores = (
  heuristicUtilityScore: number,
  learnedUtilityScore: number,
  heuristicWeight = 0.55,
  learnedWeight = 0.45
): number => heuristicUtilityScore * heuristicWeight + learnedUtilityScore * learnedWeight;
