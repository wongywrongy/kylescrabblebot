"""Iteratively fit bidding and cash-out parameters to game scores; retain a validated champion."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import signal
import sys
from threading import Event
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import torch

BOUNDS = [[.55, 1.45], [.55, 1.45], [.55, 1.45], [10, 35], [0, 1.4], [.45, 1]]
DEFAULTS = [1, 1, 1, 10, 0, 1]
SOURCES = ["market", "learned-market"]
POLICY = "src/strategy-trained-market.ts"


def paired(champion, challenger):
    old = {r["match"]: r for r in champion["results"]}
    new = {r["match"]: r for r in challenger["results"]}
    if not old or set(old) != set(new):
        raise ValueError("Replay matches do not align")
    if champion["historyHash"] != challenger["historyHash"]:
        raise ValueError("Replay snapshots differ")
    deltas = []
    for match in old:
        a, b = old[match], new[match]
        if a["initialRack"] != b["initialRack"]:
            raise ValueError("Replay starting racks differ")
        for row in [a, b]:
            assert row["balance"] == 100 + row["score"] - row["spent"]
            assert row["usedTiles"] + row["unusedTiles"] == 5 + row["acquired"]
        deltas.append(b["score"] - a["score"])
    delta = statistics.mean(deltas)
    se = statistics.stdev(deltas) / math.sqrt(len(deltas)) if len(deltas) > 1 else float("inf")
    return {"matches": len(deltas), "scoreDelta": delta, "lower95": delta - 1.96 * se,
            "upper95": delta + 1.96 * se,
            "replayWinDelta": challenger["all"]["win"] - champion["all"]["win"]}


def promote(comparison):
    # Repeated validation selects candidates; a fresh final test is still required.
    return comparison["lower95"] > 0 and comparison["replayWinDelta"] >= 0


def write_json(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n")
    temp.replace(path)


def proposal(parameters, source, future_markets=8, observed_tiles=False):
    result = {"version": 1, "futureMarkets": future_markets, "parameters": [round(float(v), 3) for v in parameters], "priceSource": source}
    if not isinstance(observed_tiles, bool):
        raise ValueError("Invalid observed tile setting")
    if observed_tiles:
        result["observedTiles"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", default="runs/gpu-history.json")
    parser.add_argument("--market-model", default="runs/gpu-market/model.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=4, help="Additional rounds; 0 runs until STOP or SIGTERM")
    parser.add_argument("--future-markets", type=int, default=32)
    parser.add_argument("--observed-tiles", action="store_true", help="Use public tile counts when sampling future markets")
    parser.add_argument("--population", type=int, default=12)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--train-first", type=int, default=2700)
    parser.add_argument("--train-last", type=int, default=2763)
    parser.add_argument("--validation-first", type=int, default=2994)
    parser.add_argument("--validation-last", type=int, default=3168)
    parser.add_argument("--resume", type=Path)
    args = parser.parse_args()
    if args.rounds < 0 or args.workers < 1 or args.population < 4:
        parser.error("Nonnegative rounds, positive workers and population >=4 required")
    if not 1 <= args.future_markets <= 64:
        parser.error("--future-markets must be within 1..64")
    if not args.train_first <= args.train_last < args.validation_first <= args.validation_last:
        parser.error("Training and validation must be ordered and disjoint")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required; run outside the sandbox")
    torch.set_num_threads(4)
    torch.manual_seed(20261024)
    args.output.mkdir(parents=True, exist_ok=False)
    files = [__file__, POLICY, "src/strategy-market.ts", "src/strategy-learned-market.ts",
             "src/strategy-montecarlo.ts", "src/experiment-inventory-public.ts", "src/remaining-pool.ts",
             "src/market-prices.json", args.market_model, args.history, "../spacetimedb/wordlist.txt"]
    hashes = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files}
    ranges = {"train": [args.train_first, args.train_last],
              "validation": [args.validation_first, args.validation_last]}
    write_json(args.output / "protocol.json", {
        "parameters": ["earlyBidScale", "middleBidScale", "lateBidScale", "cashOutBelow", "completionFloor", "cashCapFraction"],
        "bounds": BOUNDS, "ranges": ranges, "hashes": hashes, "args": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        "device": torch.cuda.get_device_name(), "objective": "Mean replay score; promotion requires positive paired lower95 and no loss of replay wins.",
        "limitations": "GPU samples and updates the cross-entropy search distribution; CPU game replays dominate runtime. Frozen opponents and synthetic racks are diagnostic only."})
    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    start = time.monotonic()
    evaluations = 0

    def evaluate(candidate, split):
        key = hashlib.sha256(json.dumps(candidate, sort_keys=True).encode()).hexdigest()[:16]
        output = args.output / f"{key}-{split}.json"
        if not output.exists():
            env = dict(os.environ, POLICY_PARAMS=json.dumps(candidate["parameters"]),
                       POLICY_PRICE_SOURCE=candidate["priceSource"], MARKET_MODEL=args.market_model,
                       POLICY_MARKETS=str(candidate["futureMarkets"]),
                       POLICY_OBSERVED_TILES=json.dumps(candidate.get("observedTiles", False)))
            env.pop("POLICY_MODEL", None)
            for name, value in {"MC_K": 24, "MC_LAMBDA": .5, "MC_PRICE": 13, "MC_WIN": .25,
                                "MC_END": 5, "MC_PACE": .5, "MC_PACE_MAX": 2.5}.items():
                env[name] = str(value)
            with output.with_suffix(".log").open("w") as log:
                subprocess.run(["node", "--import", "tsx", "src/experiment-inventory-public.ts",
                                POLICY, str(output), args.history, *map(str, ranges[split])],
                               env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        return json.loads(output.read_text())

    observed_tiles = args.observed_tiles
    incumbent = proposal(DEFAULTS, "market", observed_tiles=observed_tiles)
    if args.resume:
        saved = json.loads(args.resume.read_text())
        observed_tiles = args.observed_tiles or saved.get("observedTiles", False)
        incumbent = proposal(saved["parameters"], saved["priceSource"], saved.get("futureMarkets", 8), observed_tiles)
    write_json(args.output / "status.json", {"status": "initializing", "stage": "evaluating incumbent", "pid": os.getpid(), "champion": incumbent})
    incumbent_train = evaluate(incumbent, "train")
    incumbent_validation = evaluate(incumbent, "validation")
    lower = torch.tensor([b[0] for b in BOUNDS], device="cuda")
    upper = torch.tensor([b[1] for b in BOUNDS], device="cuda")
    mean = torch.tensor(incumbent["parameters"], device="cuda")
    std = (upper - lower) * .25
    learned_probability = .5
    seen = {json.dumps(incumbent, sort_keys=True)}
    offset = 0
    if args.resume:
        state_path = args.resume.parent / "search-state.json"
        previous_rounds = sorted(args.resume.parent.glob("round-*.json"), key=lambda p: int(p.stem.split("-")[-1]))
        if state_path.exists() or previous_rounds:
            state = json.loads((state_path if state_path.exists() else previous_rounds[-1]).read_text())
            mean = torch.tensor(state["searchMean"], device="cuda")
            std = torch.tensor(state["searchStd"], device="cuda")
            if mean.shape != (6,) or std.shape != (6,) or not torch.isfinite(mean).all() or not torch.isfinite(std).all() or (std < 0).any():
                raise ValueError("Invalid saved search state")
            mean = mean.clamp(lower, upper)
            learned_probability = state["learnedProbability"]
            offset = state["generation"]
            if "cudaRngState" in state:
                torch.cuda.set_rng_state(torch.tensor(state["cudaRngState"], dtype=torch.uint8))
                seen.update(state["seen"])
            else:
                torch.manual_seed(20261024 + offset)
                for path in previous_rounds:
                    for row in json.loads(path.read_text())["candidates"]:
                        c = row["candidate"]
                        seen.add(json.dumps(proposal(c["parameters"], c["priceSource"], c.get("futureMarkets", 8), c.get("observedTiles", False)), sort_keys=True))
    progress = {"status": "running", "round": offset, "champion": incumbent,
                "championValidation": incumbent_validation["all"], "evaluations": 2}
    write_json(args.output / "champion.json", incumbent)
    write_json(args.output / "status.json", progress)
    print(json.dumps(progress), flush=True)
    completed = 0
    while args.rounds == 0 or completed < args.rounds:
        if stop.is_set() or (args.output / "STOP").exists():
            break
        generation = offset + completed + 1
        candidates = [incumbent]
        deeper = proposal(incumbent["parameters"], incumbent["priceSource"], args.future_markets, observed_tiles)
        if json.dumps(deeper, sort_keys=True) not in seen:
            candidates.append(deeper)
            seen.add(json.dumps(deeper, sort_keys=True))
        attempts = 0
        while len(candidates) < args.population:
            attempts += 1
            if attempts > args.population * 100:
                raise RuntimeError("Search exhausted distinct candidates")
            sample = torch.clamp(mean + torch.randn(6, device="cuda") * std, lower, upper).cpu().tolist()
            sample[3] = round(sample[3])
            source = SOURCES[int(torch.rand((), device="cuda").item() < learned_probability)]
            item = proposal(sample, source, args.future_markets, observed_tiles)
            key = json.dumps(item, sort_keys=True)
            if key not in seen:
                seen.add(key)
                candidates.append(item)
        ranked = [(incumbent, incumbent_train)]
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            pending = {pool.submit(evaluate, item, "train"): item for item in candidates[1:]}
            for future in as_completed(pending):
                item, result = pending[future], future.result()
                ranked.append((item, result))
                evaluations += 1
                progress.update(round=generation, evaluations=evaluations + 2, elapsedSeconds=time.monotonic() - start)
                write_json(args.output / "status.json", progress)
                print(json.dumps({"round": generation, "candidate": item, "trainScore": result["all"]["score"]}), flush=True)
        ranked.sort(key=lambda x: (x[1]["all"]["score"], x[1]["all"]["win"]), reverse=True)
        elite = ranked[:max(2, args.population // 4)]
        elite_parameters = torch.tensor([item["parameters"] for item, _ in elite], device="cuda")
        mean = .5 * mean + .5 * elite_parameters.mean(0)
        std = torch.maximum(.5 * std + .5 * elite_parameters.std(0, unbiased=False), .06 * (upper - lower))
        learned_probability = max(.1, min(.9, sum(item["priceSource"] == "learned-market" for item, _ in elite) / len(elite)))
        trials = []
        for candidate, training in ranked[:2]:
            if candidate == incumbent or training["all"]["score"] <= incumbent_train["all"]["score"]:
                continue
            validation = evaluate(candidate, "validation")
            comparison = paired(incumbent_validation, validation)
            accepted = promote(comparison)
            trials.append({"candidate": candidate, "training": training["all"], "validation": validation["all"],
                           "comparison": comparison, "accepted": accepted})
            if accepted:
                incumbent, incumbent_train, incumbent_validation = candidate, training, validation
                write_json(args.output / "champion.json", incumbent)
            print(json.dumps({"round": generation, "validation": trials[-1]}), flush=True)
        for path, before in hashes.items():
            if hashlib.sha256(Path(path).read_bytes()).hexdigest() != before:
                raise RuntimeError(f"Training input changed: {path}")
        write_json(args.output / f"round-{generation}.json", {
            "generation": generation, "candidates": [{"candidate": c, "training": r["all"]} for c, r in ranked],
            "validation": trials, "champion": incumbent, "championValidation": incumbent_validation["all"],
            "searchMean": mean.cpu().tolist(), "searchStd": std.cpu().tolist(), "learnedProbability": learned_probability})
        write_json(args.output / "search-state.json", {
            "generation": generation, "searchMean": mean.cpu().tolist(), "searchStd": std.cpu().tolist(),
            "learnedProbability": learned_probability, "seen": sorted(seen),
            "cudaRngState": torch.cuda.get_rng_state().cpu().tolist()})
        completed += 1
        progress.update(round=generation, champion=incumbent, championValidation=incumbent_validation["all"],
                        elapsedSeconds=time.monotonic() - start)
        write_json(args.output / "status.json", progress)
    progress.update(status="stopped" if stop.is_set() or (args.output / "STOP").exists() else "completed", elapsedSeconds=time.monotonic() - start)
    write_json(args.output / "status.json", progress)
    print(json.dumps(progress), flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        if "--output" in sys.argv:
            status = Path(sys.argv[sys.argv.index("--output") + 1]) / "status.json"
            if status.exists():
                progress = json.loads(status.read_text())
                progress.update(status="stopped" if isinstance(error, KeyboardInterrupt) else "failed",
                                error=str(error))
                write_json(status, progress)
        raise
