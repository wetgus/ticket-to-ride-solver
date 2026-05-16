import argparse
import json
import os
import subprocess
import sys
import time
from typing import Dict, List


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEARCH_SCRIPT = os.path.join(ROOT_DIR, "tools", "search_improve_prefix.py")


def write_json(path: str, payload: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def load_json(path: str) -> Dict:
    with open(path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run follow-up prefix searches by seeding each game with the best first action from a prior search summary."
    )
    parser.add_argument("--python-path", default=sys.executable)
    parser.add_argument("--source-summary-json", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--take-prefix-length", type=int, default=1)
    parser.add_argument("--beam-width", type=int, default=4)
    parser.add_argument("--branch-factor", type=int, default=6)
    parser.add_argument("--depth", type=int, default=2)
    parser.add_argument("--skip-codex-decisions", type=int, default=1)
    parser.add_argument("--policy-weights-json", default="config/policy-weights.v1.0.5.json")
    parser.add_argument("--lineup", nargs="+", default=["codex", "osa", "lra", "path"])
    args = parser.parse_args()

    summary_path = (
        args.source_summary_json
        if os.path.isabs(args.source_summary_json)
        else os.path.join(ROOT_DIR, args.source_summary_json)
    )
    output_dir = (
        args.output_dir
        if os.path.isabs(args.output_dir)
        else os.path.join(ROOT_DIR, args.output_dir)
    )
    os.makedirs(output_dir, exist_ok=True)

    summary = load_json(summary_path)
    per_seed = summary.get("perSeed", [])
    started_at = time.time()
    manifest = {
        "sourceSummaryJson": args.source_summary_json,
        "takePrefixLength": args.take_prefix_length,
        "beamWidth": args.beam_width,
        "branchFactor": args.branch_factor,
        "depth": args.depth,
        "skipCodexDecisions": args.skip_codex_decisions,
        "policyWeightsJson": args.policy_weights_json,
        "lineup": args.lineup,
        "runs": [],
    }

    for seed_entry in per_seed:
        seed = int(seed_entry["seed"])
        best_prefix = list(seed_entry.get("best", {}).get("forcedPrefix", []))
        seeded_prefix = best_prefix[: args.take_prefix_length]
        prefix_file = os.path.join(output_dir, f"seed-{seed}-prefix.json")
        summary_file = os.path.join(output_dir, f"seed-{seed}-summary.json")
        results_file = os.path.join(output_dir, f"seed-{seed}-results.jsonl")
        replay_file = os.path.join(output_dir, f"seed-{seed}-best-replays.json")
        console_file = os.path.join(output_dir, f"seed-{seed}-console.log")

        write_json(prefix_file, seeded_prefix)

        command = [
            args.python_path,
            SEARCH_SCRIPT,
            "--games",
            "1",
            "--seed-base",
            str(seed),
            "--lineup",
            *args.lineup,
            "--policy-weights-json",
            args.policy_weights_json,
            "--beam-width",
            str(args.beam_width),
            "--branch-factor",
            str(args.branch_factor),
            "--depth",
            str(args.depth),
            "--skip-codex-decisions",
            str(args.skip_codex_decisions),
            "--initial-prefix-json",
            prefix_file,
            "--output-json",
            summary_file,
            "--output-jsonl",
            results_file,
            "--export-best-replays-json",
            replay_file,
        ]

        print(f"=== Follow-up seed {seed} with prefix length {len(seeded_prefix)} ===")
        completed = subprocess.run(
            command,
            cwd=ROOT_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        with open(console_file, "w", encoding="utf-8") as handle:
            handle.write(completed.stdout)
        print(completed.stdout)

        manifest["runs"].append(
            {
                "seed": seed,
                "prefixFile": prefix_file,
                "summaryFile": summary_file,
                "resultsFile": results_file,
                "replayFile": replay_file,
                "consoleFile": console_file,
                "seededPrefix": seeded_prefix,
            }
        )

    manifest["elapsedSeconds"] = round(time.time() - started_at, 2)
    write_json(os.path.join(output_dir, "batch-manifest.json"), manifest)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
