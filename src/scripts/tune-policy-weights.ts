import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_POLICY_WEIGHTS,
  type PolicyWeights
} from "../engine/recommendations.js";

interface TuningOptions {
  baseWeightsPath: string;
  outputDir: string;
  pythonPath: string;
  games: number;
  iterations: number;
  seedBase: number;
  rotations: number;
  lineup: string[];
  heuristicWeight: number;
  learnedWeight: number;
  policyModelPath?: string | undefined;
}

interface BenchmarkSummary {
  aggregateGameCount: number;
  aggregateCodexWinRate: number;
  aggregateCodexAverageScore: number;
  aggregateCodexAveragePlace: number;
  aggregateScoreP10?: number;
  aggregateScoreP90?: number;
  aggregatePlacementCounts?: Record<string, number>;
  elapsedSeconds?: number;
}

interface TuningRunRecord {
  runIndex: number;
  weightsPath: string;
  summaryPath: string;
  weights: PolicyWeights;
  metrics: {
    games: number;
    winRate: number;
    averageScore: number;
    averagePlace: number;
    scoreP10: number;
    scoreP90: number;
    elapsedSeconds: number;
  };
  objective: number;
}

const DEFAULT_PYTHON_WINDOWS =
  "C:\\Users\\Oleksandr\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe";
const WEIGHT_KEYS = Object.keys(DEFAULT_POLICY_WEIGHTS) as Array<keyof PolicyWeights>;
const BOUNDED_WEIGHT_KEYS: Array<keyof PolicyWeights> = [
  "drawPenaltyScale",
  "claimBonusScale",
  "openingBlindBonusScale",
  "openingFaceUpTaxScale",
  "earlyLocomotiveTaxScale",
  "nonPriorityVisibleTaxScale",
  "sameTurnVisibleFollowThroughBonusScale",
  "sameTurnVisibleFollowThroughTaxScale",
  "ticketColorDemandScale",
  "ticketPathColorScale",
  "offTicketClaimPenaltyScale",
  "colorPriorityDemandScale",
  "colorPriorityPathScale",
  "colorPriorityCommittedScale",
  "colorPriorityVisibleScale"
];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const parseArgs = (): TuningOptions => {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    options.set(token, value);
    index += 2;
  }

  const cwd = process.cwd();
  const defaultOutputDir = path.resolve(cwd, "artifacts", "policy-weight-tuning");
  const baseWeightsPath = path.resolve(
    cwd,
    options.get("--base-weights") ?? "config/policy-weights.v1.0.3.json"
  );
  const outputDir = path.resolve(cwd, options.get("--output-dir") ?? defaultOutputDir);
  const pythonPath =
    options.get("--python") ??
    (fs.existsSync(DEFAULT_PYTHON_WINDOWS) ? DEFAULT_PYTHON_WINDOWS : "python");
  const games = Number.parseInt(options.get("--games") ?? "4", 10);
  const iterations = Number.parseInt(options.get("--iterations") ?? "8", 10);
  const seedBase = Number.parseInt(options.get("--seed-base") ?? "5000", 10);
  const rotations = Number.parseInt(options.get("--rotations") ?? "1", 10);
  const heuristicWeight = Number.parseFloat(options.get("--heuristic-weight") ?? "0.55");
  const learnedWeight = Number.parseFloat(options.get("--learned-weight") ?? "0.45");
  const lineup = (options.get("--lineup") ?? "codex,osa,lra,path")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const policyModelPath = options.get("--policy-model");

  if (games <= 0 || iterations <= 0 || rotations <= 0) {
    throw new Error("games, iterations, and rotations must be positive integers.");
  }

  const resolvedOptions: TuningOptions = {
    baseWeightsPath,
    outputDir,
    pythonPath,
    games,
    iterations,
    seedBase,
    rotations,
    lineup,
    heuristicWeight,
    learnedWeight,
    policyModelPath
  };

  return resolvedOptions;
};

const loadWeights = (weightsPath: string): PolicyWeights => {
  const raw = fs.readFileSync(weightsPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PolicyWeights>;
  return {
    ...DEFAULT_POLICY_WEIGHTS,
    ...parsed
  };
};

const computeObjective = (summary: BenchmarkSummary): number => {
  const winRate = summary.aggregateCodexWinRate ?? 0;
  const averageScore = summary.aggregateCodexAverageScore ?? 0;
  const averagePlace = summary.aggregateCodexAveragePlace ?? 4;
  const scoreP10 = summary.aggregateScoreP10 ?? averageScore;
  const scoreP90 = summary.aggregateScoreP90 ?? averageScore;

  return (
    winRate * 120 +
    averageScore * 0.9 -
    averagePlace * 14 +
    scoreP10 * 0.18 +
    scoreP90 * 0.06
  );
};

const chooseMutationCount = (): number => {
  const roll = Math.random();
  if (roll < 0.25) {
    return 2;
  }
  if (roll < 0.7) {
    return 3;
  }
  if (roll < 0.92) {
    return 4;
  }
  return 5;
};

const sampleWithoutReplacement = <T>(items: T[], count: number): T[] => {
  const pool = [...items];
  const result: T[] = [];
  for (let index = 0; index < count && pool.length > 0; index += 1) {
    const pickIndex = Math.floor(Math.random() * pool.length);
    const [picked] = pool.splice(pickIndex, 1);
    if (picked !== undefined) {
      result.push(picked);
    }
  }
  return result;
};

const mutateWeights = (base: PolicyWeights): PolicyWeights => {
  const next: PolicyWeights = { ...base };
  const mutationKeys = sampleWithoutReplacement(
    BOUNDED_WEIGHT_KEYS,
    chooseMutationCount()
  );

  for (const key of mutationKeys) {
    const current = next[key];
    const factor =
      Math.random() < 0.15
        ? 0.6 + Math.random() * 0.9
        : 0.82 + Math.random() * 0.36;
    next[key] = clamp(Number((current * factor).toFixed(4)), 0.2, 3.0);
  }

  return next;
};

const writeJson = (targetPath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const appendJsonl = (targetPath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.appendFileSync(targetPath, `${JSON.stringify(value)}\n`, "utf8");
};

const runBenchmark = (
  options: TuningOptions,
  weightsPath: string,
  runIndex: number
): BenchmarkSummary => {
  const runDir = path.join(options.outputDir, `run-${String(runIndex).padStart(3, "0")}`);
  fs.mkdirSync(runDir, { recursive: true });

  const summaryPath = path.join(runDir, "summary.json");
  const trainingPath = path.join(runDir, "training.jsonl");
  const failedPath = path.join(runDir, "failed.jsonl");
  const progressPath = path.join(runDir, "progress.json");

  const commandArgs = [
    path.resolve(process.cwd(), "tools", "run_external_benchmark.py"),
    "--games",
    String(options.games),
    "--rotations",
    String(options.rotations),
    "--seed-base",
    String(options.seedBase + runIndex * 100),
    "--lineup",
    ...options.lineup,
    "--policy-weights-json",
    weightsPath,
    "--heuristic-weight",
    String(options.heuristicWeight),
    "--learned-weight",
    String(options.learnedWeight),
    "--export-training-jsonl",
    trainingPath,
    "--export-summary-json",
    summaryPath,
    "--export-failed-jsonl",
    failedPath,
    "--export-progress-json",
    progressPath
  ];

  if (options.policyModelPath) {
    commandArgs.push("--policy-model", path.resolve(process.cwd(), options.policyModelPath));
  }

  const result = spawnSync(options.pythonPath, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe"
  });

  fs.writeFileSync(
    path.join(runDir, "stdout.log"),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    "utf8"
  );

  if (result.status !== 0) {
    throw new Error(
      `Benchmark run ${runIndex} failed with exit code ${result.status}. See ${path.join(
        runDir,
        "stdout.log"
      )}`
    );
  }

  return JSON.parse(fs.readFileSync(summaryPath, "utf8")) as BenchmarkSummary;
};

const formatMetricLine = (record: TuningRunRecord): string =>
  `run=${record.runIndex} objective=${record.objective.toFixed(2)} ` +
  `win=${record.metrics.winRate.toFixed(3)} ` +
  `score=${record.metrics.averageScore.toFixed(2)} ` +
  `place=${record.metrics.averagePlace.toFixed(2)} ` +
  `p10=${record.metrics.scoreP10.toFixed(2)} ` +
  `p90=${record.metrics.scoreP90.toFixed(2)}`;

const main = (): void => {
  const options = parseArgs();
  fs.mkdirSync(options.outputDir, { recursive: true });

  const baseWeights = loadWeights(options.baseWeightsPath);
  const ledgerPath = path.join(options.outputDir, "results.jsonl");
  const bestWeightsPath = path.join(options.outputDir, "best-weights.json");
  const bestSummaryPath = path.join(options.outputDir, "best-summary.json");

  const runRecords: TuningRunRecord[] = [];
  let incumbentWeights = { ...baseWeights };
  let bestRecord: TuningRunRecord | null = null;

  for (let runIndex = 0; runIndex < options.iterations; runIndex += 1) {
    const candidateWeights = runIndex === 0 ? { ...baseWeights } : mutateWeights(incumbentWeights);
    const runDir = path.join(options.outputDir, `run-${String(runIndex).padStart(3, "0")}`);
    const weightsPath = path.join(runDir, "weights.json");
    writeJson(weightsPath, candidateWeights);

    const summary = runBenchmark(options, weightsPath, runIndex);
    const record: TuningRunRecord = {
      runIndex,
      weightsPath,
      summaryPath: path.join(runDir, "summary.json"),
      weights: candidateWeights,
      metrics: {
        games: summary.aggregateGameCount ?? 0,
        winRate: summary.aggregateCodexWinRate ?? 0,
        averageScore: summary.aggregateCodexAverageScore ?? 0,
        averagePlace: summary.aggregateCodexAveragePlace ?? 0,
        scoreP10: summary.aggregateScoreP10 ?? summary.aggregateCodexAverageScore ?? 0,
        scoreP90: summary.aggregateScoreP90 ?? summary.aggregateCodexAverageScore ?? 0,
        elapsedSeconds: summary.elapsedSeconds ?? 0
      },
      objective: computeObjective(summary)
    };

    runRecords.push(record);
    appendJsonl(ledgerPath, record);
    console.log(formatMetricLine(record));

    if (!bestRecord || record.objective > bestRecord.objective) {
      bestRecord = record;
      incumbentWeights = { ...candidateWeights };
      writeJson(bestWeightsPath, bestRecord.weights);
      writeJson(bestSummaryPath, {
        record: bestRecord,
        options
      });
      console.log(`new best -> ${formatMetricLine(bestRecord)}`);
    }
  }

  if (!bestRecord) {
    throw new Error("No tuning records were produced.");
  }

  const finalPayload = {
    options,
    best: bestRecord,
    runsEvaluated: runRecords.length,
    ledgerPath,
    bestWeightsPath
  };

  writeJson(path.join(options.outputDir, "final-summary.json"), finalPayload);
  console.log(JSON.stringify(finalPayload, null, 2));
};

main();
