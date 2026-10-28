"""Fit V(state) = future score (final - current) from self-play traces; export an MLP as JSON for strategy-value.ts."""
import argparse, glob, json, sys
import torch
from torch import nn

def feats(r):
    return [min(r["cash"], 250) / 100, r["bag"] / 68, min(r["opp"], 250) / 100, sum(r["rack"]) / 10] + [c / 3 for c in r["rack"]]

def load(paths):
    X, y = [], []
    for p in paths:
        for line in open(p):
            r = json.loads(line); X.append(feats(r)); y.append(r["final"] - r["score"])
    return torch.tensor(X), torch.tensor(y, dtype=torch.float32)

def main():
    p = argparse.ArgumentParser(); p.add_argument("--traces", required=True); p.add_argument("--out", required=True)
    p.add_argument("--hidden", type=int, default=128); p.add_argument("--epochs", type=int, default=30); p.add_argument("--lr", type=float, default=2e-3)
    a = p.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    X, y = load(sorted(glob.glob(a.traces)))
    n = len(X); cut = int(n * 0.9)
    Xtr, ytr, Xte, yte = X[:cut].to(dev), y[:cut].to(dev), X[cut:].to(dev), y[cut:].to(dev)
    print(f"rows {n} mean future {y.mean():.1f} std {y.std():.1f}", file=sys.stderr)
    torch.manual_seed(0)
    net = nn.Sequential(nn.Linear(X.shape[1], a.hidden), nn.ReLU(), nn.Linear(a.hidden, a.hidden), nn.ReLU(), nn.Linear(a.hidden, 1)).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=a.lr)
    for ep in range(a.epochs):
        perm = torch.randperm(cut, device=dev)
        for i in range(0, cut, 1024):
            idx = perm[i:i + 1024]; opt.zero_grad(); l = nn.functional.mse_loss(net(Xtr[idx]).squeeze(1), ytr[idx]); l.backward(); opt.step()
        if ep % 5 == 4 or ep == a.epochs - 1:
            with torch.no_grad(): pte = net(Xte).squeeze(1); print(f"ep {ep+1} test RMSE {((pte-yte)**2).mean().sqrt():.2f} MAE {(pte-yte).abs().mean():.2f} (std {yte.std():.2f})", file=sys.stderr)
    layers = [{"w": l.weight.detach().cpu().tolist(), "b": l.bias.detach().cpu().tolist()} for l in net if isinstance(l, nn.Linear)]
    json.dump({"layers": layers, "features": "min(cash,250)/100,bag/68,min(opp,250)/100,racksize/10,rack26/3"}, open(a.out, "w"))

if __name__ == "__main__":
    main()
