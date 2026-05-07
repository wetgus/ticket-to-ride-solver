import type { ActionRecommendation } from "../model/evaluation.js";
import type { TurnPhase } from "../model/game-state.js";
import type { TrainingCandidateActionRow } from "./types.js";
import {
  LEARNED_POLICY_FEATURE_NAMES,
  POLICY_FEATURE_NAMES,
  buildPolicyFeatureVectorFromRecommendation,
  buildPolicyFeatureVectorFromRow,
  type PolicyFeatureContext,
  vectorToFeatureArray
} from "./feature-vector.js";
import { computeTrainingTarget } from "./targets.js";

export type PolicyPhaseBucket = "ticket-keep" | "main-turn";

export interface PairwisePhasePolicyModel {
  version: 1;
  kind: "pairwise-linear";
  phaseBucket: PolicyPhaseBucket;
  featureNames: string[];
  featureMeans: number[];
  featureScales: number[];
  weights: number[];
  bias: number;
  trainingDecisionCount: number;
  trainingPairCount: number;
  metrics: {
    trainAccuracy: number;
    validationAccuracy: number;
    trainLogLoss: number;
    validationLogLoss: number;
  };
}

export interface PhasePolicyBundleModel {
  version: 1;
  kind: "phase-policy-bundle";
  phaseModels: Partial<Record<PolicyPhaseBucket, PairwisePhasePolicyModel>>;
  metadata: {
    trainingDecisionCount: number;
    trainingPairCount: number;
    phaseBuckets: PolicyPhaseBucket[];
  };
}

export interface PairwiseTrainingOptions {
  epochs?: number;
  learningRate?: number;
  l2Penalty?: number;
  validationSplit?: number;
}

interface DecisionGroup {
  splitKey: string;
  phaseBucket: PolicyPhaseBucket;
  rows: TrainingCandidateActionRow[];
  chosenRow: TrainingCandidateActionRow;
  qualityTarget: number;
}

interface PairwiseExample {
  deltaFeatures: number[];
  label: 0 | 1;
  weight: number;
  splitKey: string;
}

const DEFAULT_OPTIONS: Required<PairwiseTrainingOptions> = {
  epochs: 900,
  learningRate: 0.04,
  l2Penalty: 0.0015,
  validationSplit: 0.2
};

const MIN_FEATURE_SCALE = 0.1;
const NORMALIZED_FEATURE_LIMIT = 8;

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

const dot = (left: number[], right: number[]): number =>
  left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

const sigmoid = (value: number): number => {
  if (value >= 0) {
    const expValue = Math.exp(-value);
    return 1 / (1 + expValue);
  }

  const expValue = Math.exp(value);
  return expValue / (1 + expValue);
};

const clampMagnitude = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

const normalizeFeatureValue = (
  value: number,
  meanValue: number,
  scaleValue: number
): number =>
  clampMagnitude(
    (value - meanValue) / Math.max(scaleValue, MIN_FEATURE_SCALE),
    NORMALIZED_FEATURE_LIMIT
  );

const createFeatureMatrix = (rows: TrainingCandidateActionRow[]): number[][] =>
  rows.map((row) => vectorToFeatureArray(buildPolicyFeatureVectorFromRow(row), LEARNED_POLICY_FEATURE_NAMES));

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
    const columnMean = mean(values);
    const columnScale = standardDeviation(values, columnMean);
    means.push(columnMean);
    scales.push(columnScale);
  }

  return {
    means,
    scales,
    normalized: matrix.map((row) =>
      row.map((value, columnIndex) =>
        normalizeFeatureValue(value, means[columnIndex]!, scales[columnIndex]!)
      )
    )
  };
};

const getRowDecisionKey = (row: TrainingCandidateActionRow): string =>
  `${row.gameId}:${row.playerId}:${row.turnIndex}:${row.phase}`;

export const getPolicyPhaseBucket = (phase: TurnPhase): PolicyPhaseBucket =>
  phase === "resolving-ticket-keep" ? "ticket-keep" : "main-turn";

const buildDecisionGroups = (rows: TrainingCandidateActionRow[]): DecisionGroup[] => {
  const groupedRows = new Map<string, TrainingCandidateActionRow[]>();

  for (const row of rows) {
    const key = getRowDecisionKey(row);
    const existingRows = groupedRows.get(key);
    if (existingRows) {
      existingRows.push(row);
    } else {
      groupedRows.set(key, [row]);
    }
  }

  const decisionGroups: DecisionGroup[] = [];
  for (const [key, groupRows] of groupedRows.entries()) {
    const chosenRow = groupRows.find((row) => row.wasChosen);
    if (!chosenRow || groupRows.length < 2) {
      continue;
    }

    decisionGroups.push({
      splitKey: `${chosenRow.gameId}:${chosenRow.playerId}`,
      phaseBucket: getPolicyPhaseBucket(chosenRow.phase),
      rows: groupRows,
      chosenRow,
      qualityTarget: computeTrainingTarget(chosenRow)
    });
  }

  return decisionGroups;
};

const buildPairwiseExamplesForPhase = (
  decisionGroups: DecisionGroup[],
  phaseBucket: PolicyPhaseBucket,
  normalizedRowFeatures: Map<string, number[]>
): {
  examples: PairwiseExample[];
  decisionCount: number;
} => {
  const phaseGroups = decisionGroups.filter((group) => group.phaseBucket === phaseBucket);
  if (phaseGroups.length === 0) {
    return { examples: [], decisionCount: 0 };
  }

  const targetMean = mean(phaseGroups.map((group) => group.qualityTarget));
  const targetScale = standardDeviation(
    phaseGroups.map((group) => group.qualityTarget),
    targetMean
  );

  const examples: PairwiseExample[] = [];

  for (const group of phaseGroups) {
    const chosenFeatureKey = `${getRowDecisionKey(group.chosenRow)}:${group.chosenRow.candidateActionId}`;
    const chosenFeatures = normalizedRowFeatures.get(chosenFeatureKey);
    if (!chosenFeatures) {
      continue;
    }

    const qualityWeight = Math.max(
      0.25,
      Math.min(2, 1 + 0.35 * ((group.qualityTarget - targetMean) / targetScale))
    );

    for (const candidateRow of group.rows) {
      if (candidateRow.wasChosen) {
        continue;
      }

      const candidateFeatureKey = `${getRowDecisionKey(candidateRow)}:${candidateRow.candidateActionId}`;
      const candidateFeatures = normalizedRowFeatures.get(candidateFeatureKey);
      if (!candidateFeatures) {
        continue;
      }

      const chosenMinusCandidate = chosenFeatures.map(
        (value, index) => value - (candidateFeatures[index] ?? 0)
      );
      const candidateMinusChosen = chosenMinusCandidate.map((value) => -value);

      examples.push({
        deltaFeatures: chosenMinusCandidate.map((value) =>
          clampMagnitude(value, NORMALIZED_FEATURE_LIMIT * 2)
        ),
        label: 1,
        weight: qualityWeight,
        splitKey: group.splitKey
      });
      examples.push({
        deltaFeatures: candidateMinusChosen.map((value) =>
          clampMagnitude(value, NORMALIZED_FEATURE_LIMIT * 2)
        ),
        label: 0,
        weight: qualityWeight,
        splitKey: group.splitKey
      });
    }
  }

  return {
    examples,
    decisionCount: phaseGroups.length
  };
};

const trainPairwiseLinearModel = (
  trainingExamples: PairwiseExample[],
  featureCount: number,
  options: Required<PairwiseTrainingOptions>
): { weights: number[]; bias: number } => {
  const weights = Array.from({ length: featureCount }, () => 0);
  let bias = 0;
  const totalWeight = Math.max(
    1,
    trainingExamples.reduce((sum, example) => sum + example.weight, 0)
  );

  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    const weightGradients = Array.from({ length: featureCount }, () => 0);
    let biasGradient = 0;

    for (const example of trainingExamples) {
      const logit = dot(example.deltaFeatures, weights) + bias;
      const prediction = sigmoid(logit);
      const error = (prediction - example.label) * example.weight;

      biasGradient += error;
      for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
        weightGradients[featureIndex] =
          weightGradients[featureIndex]! + error * (example.deltaFeatures[featureIndex] ?? 0);
      }
    }

    for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
      const averageGradient =
        weightGradients[featureIndex]! / totalWeight + options.l2Penalty * weights[featureIndex]!;
      weights[featureIndex] =
        weights[featureIndex]! - options.learningRate * clampMagnitude(averageGradient, 10);
    }

    bias -= options.learningRate * clampMagnitude(biasGradient / totalWeight, 10);

    if (!Number.isFinite(bias) || weights.some((weight) => !Number.isFinite(weight))) {
      throw new Error(`Pairwise reranker diverged numerically at epoch ${epoch + 1}.`);
    }
  }

  return { weights, bias };
};

const computePairwiseMetrics = (
  examples: PairwiseExample[],
  weights: number[],
  bias: number
): { accuracy: number; logLoss: number } => {
  if (examples.length === 0) {
    return { accuracy: 0, logLoss: 0 };
  }

  let totalWeight = 0;
  let correctWeight = 0;
  let logLoss = 0;

  for (const example of examples) {
    const probability = sigmoid(dot(example.deltaFeatures, weights) + bias);
    const clampedProbability = Math.max(1e-6, Math.min(1 - 1e-6, probability));
    const predictedLabel = clampedProbability >= 0.5 ? 1 : 0;
    const label = example.label;

    totalWeight += example.weight;
    if (predictedLabel === label) {
      correctWeight += example.weight;
    }

    logLoss +=
      example.weight *
      (-(label * Math.log(clampedProbability) + (1 - label) * Math.log(1 - clampedProbability)));
  }

  return {
    accuracy: correctWeight / Math.max(totalWeight, 1e-9),
    logLoss: logLoss / Math.max(totalWeight, 1e-9)
  };
};

const trainSinglePhaseModel = (
  phaseBucket: PolicyPhaseBucket,
  rows: TrainingCandidateActionRow[],
  decisionGroups: DecisionGroup[],
  options: Required<PairwiseTrainingOptions>
): PairwisePhasePolicyModel | null => {
  const phaseRows = rows.filter((row) => getPolicyPhaseBucket(row.phase) === phaseBucket);
  if (phaseRows.length < 10) {
    return null;
  }

  const featureMatrix = createFeatureMatrix(phaseRows);
  const { normalized, means, scales } = normalizeMatrix(featureMatrix);
  const normalizedRowFeatures = new Map<string, number[]>();
  for (let index = 0; index < phaseRows.length; index += 1) {
    const row = phaseRows[index]!;
    normalizedRowFeatures.set(`${getRowDecisionKey(row)}:${row.candidateActionId}`, normalized[index]!);
  }

  const { examples, decisionCount } = buildPairwiseExamplesForPhase(
    decisionGroups,
    phaseBucket,
    normalizedRowFeatures
  );

  if (examples.length < 20 || decisionCount < 4) {
    return null;
  }

  const trainingExamples: PairwiseExample[] = [];
  const validationExamples: PairwiseExample[] = [];

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

  const { weights, bias } = trainPairwiseLinearModel(
    trainingExamples,
    LEARNED_POLICY_FEATURE_NAMES.length,
    options
  );
  const trainMetrics = computePairwiseMetrics(trainingExamples, weights, bias);
  const validationMetrics = computePairwiseMetrics(validationExamples, weights, bias);

  return {
    version: 1,
    kind: "pairwise-linear",
    phaseBucket,
    featureNames: [...LEARNED_POLICY_FEATURE_NAMES],
    featureMeans: means,
    featureScales: scales,
    weights,
    bias,
    trainingDecisionCount: decisionCount,
    trainingPairCount: examples.length,
    metrics: {
      trainAccuracy: trainMetrics.accuracy,
      validationAccuracy: validationMetrics.accuracy,
      trainLogLoss: trainMetrics.logLoss,
      validationLogLoss: validationMetrics.logLoss
    }
  };
};

export const trainPhasePairwisePolicyBundle = (
  rows: TrainingCandidateActionRow[],
  providedOptions: PairwiseTrainingOptions = {}
): PhasePolicyBundleModel => {
  const options = {
    ...DEFAULT_OPTIONS,
    ...providedOptions
  };

  const decisionGroups = buildDecisionGroups(rows);
  if (decisionGroups.length < 8) {
    throw new Error("Need at least 8 decision groups to train a phase pairwise policy bundle.");
  }

  const phaseModels: Partial<Record<PolicyPhaseBucket, PairwisePhasePolicyModel>> = {};
  for (const phaseBucket of ["ticket-keep", "main-turn"] as PolicyPhaseBucket[]) {
    const model = trainSinglePhaseModel(phaseBucket, rows, decisionGroups, options);
    if (model) {
      phaseModels[phaseBucket] = model;
    }
  }

  const builtPhaseBuckets = Object.keys(phaseModels) as PolicyPhaseBucket[];
  if (builtPhaseBuckets.length === 0) {
    throw new Error("No phase models were trainable from the provided corpus.");
  }

  return {
    version: 1,
    kind: "phase-policy-bundle",
    phaseModels,
    metadata: {
      trainingDecisionCount: decisionGroups.length,
      trainingPairCount: builtPhaseBuckets.reduce(
        (sum, bucket) => sum + (phaseModels[bucket]?.trainingPairCount ?? 0),
        0
      ),
      phaseBuckets: builtPhaseBuckets
    }
  };
};

const scoreNormalizedFeatureVector = (
  featureValues: number[],
  means: number[],
  scales: number[],
  weights: number[]
): number =>
  dot(
    featureValues.map((value, index) =>
      normalizeFeatureValue(value, means[index] ?? 0, scales[index] ?? MIN_FEATURE_SCALE)
    ),
    weights
  );

export const scoreActionRecommendationWithPairwiseModel = (
  model: PairwisePhasePolicyModel,
  recommendation: ActionRecommendation,
  context: PolicyFeatureContext
): number => {
  const vector = buildPolicyFeatureVectorFromRecommendation(recommendation, context);
  const features = vectorToFeatureArray(
    vector,
    model.featureNames as Array<(typeof POLICY_FEATURE_NAMES)[number]>
  );
  return scoreNormalizedFeatureVector(features, model.featureMeans, model.featureScales, model.weights);
};

export const scoreActionRecommendationWithPhaseBundle = (
  model: PhasePolicyBundleModel,
  recommendation: ActionRecommendation,
  context: PolicyFeatureContext
): number => {
  const phaseBucket = getPolicyPhaseBucket(context.phase);
  const phaseModel =
    model.phaseModels[phaseBucket] ??
    model.phaseModels["main-turn"] ??
    model.phaseModels["ticket-keep"];

  if (!phaseModel) {
    return 0;
  }

  return scoreActionRecommendationWithPairwiseModel(phaseModel, recommendation, context);
};
