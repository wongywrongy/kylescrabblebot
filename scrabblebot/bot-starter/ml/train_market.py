"""Fit a phase-conditioned auction-price distribution on CUDA; export CPU lookup tables."""
import argparse
import copy
import hashlib
import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import torch
from torch import nn

PHASES, LETTERS, BINS, QUANTILES = 68, 26, 201, 128


def digest(data):
    return hashlib.sha256(data).hexdigest()


def timestamp(match, field):
    return int(match[field]["__timestamp_micros_since_unix_epoch__"])


def split_matches(matches):
    matches = sorted(matches, key=lambda m: timestamp(m, "startedAt"))
    if len(matches) < 20:
        raise ValueError("Need at least 20 eligible completed matches")
    a, b = int(len(matches) * .7), int(len(matches) * .85)
    validation_start = timestamp(matches[a], "startedAt")
    test_start = timestamp(matches[b], "startedAt")
    # Concurrent matches must finish before the next partition starts.
    train = [m for m in matches[:a] if timestamp(m, "endedAt") < validation_start]
    validation = [m for m in matches[a:b] if timestamp(m, "endedAt") < test_start]
    test = matches[b:]
    if not all([train, validation, test]):
        raise ValueError("Empty chronological partition")
    return dict(train=train, validation=validation, test=test)


def dataset(history, limit):
    simulated = {b["id"] for b in history["bots"] if b["isSimulated"]}
    humans = Counter(p["matchId"] for p in history["participants"] if p["botId"] not in simulated)
    auctions = defaultdict(list)
    for a in history["auctions"]:
        auctions[a["matchId"]].append(a)
    tops = {a["auctionId"]: int(a["topBid"]) for a in history["topBids"]}
    if len(tops) != len(history["topBids"]):
        raise ValueError("Duplicate auction top bids")
    matches = [m for m in history["matches"]
               if m["status"]["tag"] == "Ended" and m["auctionType"]["tag"] == "Vickrey"
               and m["startingRackSize"] == 5 and humans[m["id"]] >= 4
               and len(auctions[m["id"]]) == PHASES]
    matches.sort(key=lambda m: timestamp(m, "startedAt"))
    splits = split_matches(matches[-limit:])
    rows = {}
    for name, games in splits.items():
        observations = []
        for match in games:
            ordered = sorted(auctions[match["id"]], key=lambda a: int(a["auctionId"]))
            if len({a["auctionId"] for a in ordered}) != PHASES:
                raise ValueError("Duplicate auctions in match")
            for i, a in enumerate(ordered):
                if len(a["letter"]) != 1 or not "A" <= a["letter"] <= "Z":
                    raise ValueError("Invalid auction letter")
                price = tops[a["auctionId"]]  # Missing labels are errors, never zero-filled.
                if not 0 <= price < BINS:
                    raise ValueError(f"Price {price} outside supported 0..{BINS - 1}")
                observations.append(((PHASES - i - 1) * LETTERS + ord(a["letter"]) - 65, price))
        rows[name] = observations
    return splits, rows


def counts(rows, device="cpu"):
    ids = torch.tensor([context * BINS + price for context, price in rows], device=device)
    return torch.bincount(ids, minlength=PHASES * LETTERS * BINS).reshape(-1, BINS).float()


def features(device="cpu"):
    letter = torch.eye(LETTERS, device=device).repeat(PHASES, 1)
    phase = torch.arange(PHASES, device=device).repeat_interleave(LETTERS).float() / (PHASES - 1)
    return torch.cat([letter, phase[:, None]], dim=1)


def network():
    return nn.Sequential(nn.Linear(27, 128), nn.ReLU(), nn.Linear(128, 128),
                         nn.ReLU(), nn.Linear(128, BINS))


def nll(log_probabilities, observations):
    return -(observations * log_probabilities).sum() / observations.sum()


def quantiles(probabilities):
    cdf = probabilities.cumsum(-1).contiguous()
    cdf[:, -1] = 1
    q = (torch.arange(QUANTILES, device=cdf.device) + .5) / QUANTILES
    return torch.searchsorted(cdf, q.expand(cdf.shape[0], -1).contiguous()).reshape(
        PHASES, LETTERS, QUANTILES).cpu().tolist()


def benchmark(initial, observations, device, steps=100):
    model = copy.deepcopy(initial).to(device)
    x, y = features(device), observations.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=.003, weight_decay=.01)
    def step():
        optimizer.zero_grad(set_to_none=True)
        loss = nll(model(x).log_softmax(-1), y)
        loss.backward()
        optimizer.step()
    for _ in range(10):
        step()
    if device == "cuda":
        torch.cuda.synchronize()
    start = time.perf_counter()
    for _ in range(steps):
        step()
    if device == "cuda":
        torch.cuda.synchronize()
    return (time.perf_counter() - start) * 1000 / steps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, default=Path("runs/gpu-history.json"))
    parser.add_argument("--output", type=Path, default=Path("runs/gpu-market"))
    parser.add_argument("--matches", type=int, default=1200)
    parser.add_argument("--epochs", type=int, default=2000)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    args = parser.parse_args()
    if args.matches < 20 or args.epochs < 1:
        parser.error("--matches must be >=20 and --epochs must be positive")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; run outside the sandbox or explicitly choose --device cpu")
    torch.set_num_threads(4)
    torch.manual_seed(20261024)
    raw = args.history.read_bytes()
    history = json.loads(raw)
    splits, rows = dataset(history, args.matches)
    args.output.mkdir(parents=True, exist_ok=False)
    observed = {name: counts(values, args.device) for name, values in rows.items()}
    x = features(args.device)
    initial = network()
    speeds = {"cpuStepMs": benchmark(initial, observed["train"].cpu(), "cpu")}
    if args.device == "cuda":
        speeds["cudaStepMs"] = benchmark(initial, observed["train"], "cuda")
        speeds["speedup"] = speeds["cpuStepMs"] / speeds["cudaStepMs"]
    print(json.dumps({"benchmark": speeds, "matches": {k: len(v) for k, v in splits.items()}}), flush=True)
    model = initial.to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=.003, weight_decay=.01)
    best_loss, best_epoch, checkpoint = float("inf"), 0, None
    start = time.perf_counter()
    for epoch in range(1, args.epochs + 1):
        optimizer.zero_grad(set_to_none=True)
        loss = nll(model(x).log_softmax(-1), observed["train"])
        if not torch.isfinite(loss):
            raise RuntimeError("Nonfinite training loss")
        loss.backward()
        optimizer.step()
        if epoch % 20 == 0 or epoch == args.epochs:
            with torch.no_grad():
                validation = nll(model(x).log_softmax(-1), observed["validation"]).item()
            if validation < best_loss:
                best_loss, best_epoch = validation, epoch
                checkpoint = copy.deepcopy(model.state_dict())
            if epoch % 100 == 0:
                print(json.dumps({"epoch": epoch, "trainNll": loss.item(), "validationNll": validation}), flush=True)
            if epoch - best_epoch >= 200:
                break
    if args.device == "cuda":
        torch.cuda.synchronize()
    training_seconds = time.perf_counter() - start
    model.load_state_dict(checkpoint)
    model.eval()
    # Same-data per-letter baseline isolates the value of the learned phase conditioning.
    prior = observed["train"].reshape(PHASES, LETTERS, BINS).sum(0) + .1
    prior /= prior.sum(-1, keepdim=True)
    with torch.no_grad():
        logp = model(x).log_softmax(-1)
        metrics = {name: {"neuralNll": nll(logp, data).item(),
                          "perLetterNll": nll(prior.repeat(PHASES, 1).log(), data).item()}
                   for name, data in observed.items()}
        prices = quantiles(logp.exp())
    metadata = {
        "history": str(args.history), "historySha256": digest(raw),
        "capturedAt": history["capturedAt"], "trainerSha256": digest(Path(__file__).read_bytes()),
        "seed": 20261024, "torch": torch.__version__, "cuda": torch.version.cuda,
        "device": torch.cuda.get_device_name(0) if args.device == "cuda" else "cpu",
        "deviceCapability": list(torch.cuda.get_device_capability(0)) if args.device == "cuda" else None,
        "splits": {name: [m["id"] for m in games] for name, games in splits.items()},
        "quoteCounts": {k: len(v) for k, v in rows.items()}, "selectedEpoch": best_epoch,
        "epochsRun": epoch, "trainingSeconds": training_seconds, "benchmark": speeds, "metrics": metrics,
        "limitations": "Public six-bot top bids; phase and letter only. Frozen-price replays cannot establish live win rates.",
    }
    encoded = json.dumps(prices, separators=(",", ":")).encode()
    artifact = {"version": 1, "provenance": metadata, "pricesSha256": digest(encoded), "prices": prices}
    (args.output / "model.json").write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
    (args.output / "report.json").write_text(json.dumps(metadata, indent=2) + "\n")
    torch.save(model.cpu().state_dict(), args.output / "weights.pt")
    print(json.dumps({k: v for k, v in metadata.items() if k != "splits"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
