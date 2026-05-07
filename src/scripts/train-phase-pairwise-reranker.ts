import fs from "node:fs";
import path from "node:path";

import { trainPhasePairwisePolicyBundle } from "../training/pairwise-reranker.js";
import type { TrainingCandidateActionRow } from "../training/types.js";

const [, , inputPathArg, outputPathArg] = process.argv;

if (!inputPathArg) {
  throw new Error(
    "Usage: node dist/scripts/train-phase-pairwise-reranker.js <input-jsonl> [output-model-json]"
  );
}

const inputPath = path.resolve(process.cwd(), inputPathArg);
const outputPath = path.resolve(
  process.cwd(),
  outputPathArg ?? "artifacts/policy-phase-pairwise-bundle.json"
);

const raw = fs.readFileSync(inputPath, "utf8");
const rows = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as TrainingCandidateActionRow);

const bundle = trainPhasePairwisePolicyBundle(rows);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      inputPath,
      outputPath,
      metadata: bundle.metadata,
      phases: Object.fromEntries(
        Object.entries(bundle.phaseModels).map(([phase, model]) => [
          phase,
          model
            ? {
                trainingDecisionCount: model.trainingDecisionCount,
                trainingPairCount: model.trainingPairCount,
                metrics: model.metrics
              }
            : null
        ])
      )
    },
    null,
    2
  )
);
