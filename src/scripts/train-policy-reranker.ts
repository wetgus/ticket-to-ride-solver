import fs from "node:fs";
import path from "node:path";

import { trainPolicyReranker } from "../training/reranker.js";
import type { TrainingCandidateActionRow } from "../training/types.js";

const [, , inputPathArg, outputPathArg] = process.argv;

if (!inputPathArg) {
  throw new Error(
    "Usage: node dist/scripts/train-policy-reranker.js <input-jsonl> [output-model-json]"
  );
}

const inputPath = path.resolve(process.cwd(), inputPathArg);
const outputPath = path.resolve(
  process.cwd(),
  outputPathArg ?? "artifacts/policy-reranker-model.json"
);

const raw = fs.readFileSync(inputPath, "utf8");
const rows = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as TrainingCandidateActionRow);

const model = trainPolicyReranker(rows);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      inputPath,
      outputPath,
      trainingRowCount: model.trainingRowCount,
      metrics: model.metrics
    },
    null,
    2
  )
);
