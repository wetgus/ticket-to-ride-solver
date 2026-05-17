import argparse
import json
import os
from collections import defaultdict
from typing import Dict, Iterable, List, Tuple


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_json(path: str) -> Dict:
    with open(path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def iter_jsonl(path: str) -> Iterable[Dict]:
    with open(path, "r", encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def write_json(path: str, payload: Dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def write_jsonl(path: str, rows: List[Dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def resolve_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(ROOT_DIR, path)


def action_key(action: Dict) -> str:
    return json.dumps(action, sort_keys=True, separators=(",", ":"))


def prefix_key(prefix: List[Dict]) -> str:
    return json.dumps(prefix, sort_keys=True, separators=(",", ":"))


def compare_records(a: Dict, b: Dict) -> Tuple[Dict, Dict, float]:
    delta_objective = float(a["objective"]) - float(b["objective"])
    if delta_objective > 0:
        return a, b, delta_objective
    if delta_objective < 0:
        return b, a, -delta_objective

    delta_score = int(a["score"]) - int(b["score"])
    if delta_score > 0:
        return a, b, float(delta_score)
    if delta_score < 0:
        return b, a, float(-delta_score)

    if int(a["place"]) < int(b["place"]):
        return a, b, float(int(b["place"]) - int(a["place"]))
    if int(b["place"]) < int(a["place"]):
        return b, a, float(int(a["place"]) - int(b["place"]))

    return a, b, 0.0


def extract_decision_metadata(record: Dict) -> Tuple[int, str]:
    forced_decisions = record.get("forcedDecisions", [])
    if not forced_decisions:
        return -1, "unknown"
    final_decision = forced_decisions[-1]
    return int(final_decision.get("decisionIndex", -1)), str(final_decision.get("phase", "unknown"))


def build_pairwise_rows(records: List[Dict], source_name: str) -> List[Dict]:
    groups: Dict[Tuple[int, str, int], List[Dict]] = defaultdict(list)
    for record in records:
        prefix = list(record.get("forcedPrefix", []))
        if not prefix:
            continue
        parent_prefix = prefix[:-1]
        decision_index, phase = extract_decision_metadata(record)
        groups[(int(record["seed"]), prefix_key(parent_prefix), decision_index)].append(record)

    rows: List[Dict] = []
    for (seed, parent_key, decision_index), siblings in groups.items():
        if len(siblings) < 2:
            continue
        for left_index in range(len(siblings)):
            for right_index in range(left_index + 1, len(siblings)):
                left = siblings[left_index]
                right = siblings[right_index]
                preferred, rejected, margin = compare_records(left, right)
                if margin <= 0:
                    continue
                phase = extract_decision_metadata(preferred)[1]
                preferred_action = preferred["forcedPrefix"][-1]
                rejected_action = rejected["forcedPrefix"][-1]
                rows.append(
                    {
                        "source": source_name,
                        "seed": seed,
                        "decisionIndex": decision_index,
                        "phase": phase,
                        "parentPrefix": preferred["forcedPrefix"][:-1],
                        "preferredAction": preferred_action,
                        "rejectedAction": rejected_action,
                        "preferredActionKey": action_key(preferred_action),
                        "rejectedActionKey": action_key(rejected_action),
                        "preferredOutcome": {
                            "score": preferred["score"],
                            "place": preferred["place"],
                            "objective": preferred["objective"],
                        },
                        "rejectedOutcome": {
                            "score": rejected["score"],
                            "place": rejected["place"],
                            "objective": rejected["objective"],
                        },
                        "deltaObjective": float(preferred["objective"]) - float(rejected["objective"]),
                        "deltaScore": int(preferred["score"]) - int(rejected["score"]),
                        "deltaPlace": int(rejected["place"]) - int(preferred["place"]),
                        "confidenceWeight": max(
                            1.0,
                            abs(float(preferred["objective"]) - float(rejected["objective"])) / 8.0,
                        ),
                    }
                )
    return rows


def load_search_records(summary_path: str, results_path: str) -> List[Dict]:
    _summary = load_json(summary_path)
    return list(iter_jsonl(results_path))


def load_followup_records(manifest_path: str) -> List[Dict]:
    manifest = load_json(manifest_path)
    records: List[Dict] = []
    for run in manifest.get("runs", []):
        results_path = resolve_path(run["resultsFile"])
        records.extend(iter_jsonl(results_path))
    return records


def summarize_rows(rows: List[Dict]) -> Dict:
    by_phase: Dict[str, int] = defaultdict(int)
    by_decision_index: Dict[str, int] = defaultdict(int)
    for row in rows:
        by_phase[row["phase"]] += 1
        by_decision_index[str(row["decisionIndex"])] += 1
    return {
        "pairCount": len(rows),
        "byPhase": dict(sorted(by_phase.items())),
        "byDecisionIndex": dict(sorted(by_decision_index.items(), key=lambda item: int(item[0]))),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export pairwise preference rows from prefix-search results and follow-up continuation searches."
    )
    parser.add_argument("--source-summary-json", required=True)
    parser.add_argument("--source-results-jsonl", required=True)
    parser.add_argument("--followup-manifest-json", default=None)
    parser.add_argument("--output-jsonl", required=True)
    parser.add_argument("--output-summary-json", required=True)
    args = parser.parse_args()

    base_records = load_search_records(
        resolve_path(args.source_summary_json),
        resolve_path(args.source_results_jsonl),
    )
    rows = build_pairwise_rows(base_records, "postkeep-search")

    if args.followup_manifest_json:
        followup_records = load_followup_records(resolve_path(args.followup_manifest_json))
        rows.extend(build_pairwise_rows(followup_records, "postkeep-followup"))

    rows.sort(
        key=lambda row: (
            row["seed"],
            row["decisionIndex"],
            -row["deltaObjective"],
            -row["deltaScore"],
        )
    )

    summary = {
        "sourceSummaryJson": args.source_summary_json,
        "sourceResultsJsonl": args.source_results_jsonl,
        "followupManifestJson": args.followup_manifest_json,
        "totals": summarize_rows(rows),
    }

    write_jsonl(resolve_path(args.output_jsonl), rows)
    write_json(resolve_path(args.output_summary_json), summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
