"""Censored regression of top bots' bids: exact when they won, upper bound (second price) otherwise. Exports an MLP as JSON."""
import argparse, json, sys
import torch
from torch import nn

def load(path):
    X, y, w = [], [], []
    for line in open(path):
        r = json.loads(line)
        f = [0.0] * 26; f[r["l"]] = 1.0
        rack = r["rack"]
        X.append(f + [r["face"] / 10, r["bag"] / 68, min(r["cash"], 200) / 100, r["score"] / 100, sum(rack) / 10] + [c / 3 for c in rack])
        y.append(r["bid"]); w.append(r["won"])
    return torch.tensor(X), torch.tensor(y, dtype=torch.float32), torch.tensor(w, dtype=torch.float32)

def loss_fn(pred, y, won):
    exact = nn.functional.smooth_l1_loss(pred, y, reduction="none")
    over = torch.relu(pred - y) ** 2  # losers: bid was at most the price paid
    return (won * exact + (1 - won) * over).mean()

def main():
    p = argparse.ArgumentParser(); p.add_argument("--train", required=True); p.add_argument("--test", required=True); p.add_argument("--out", required=True)
    p.add_argument("--hidden", type=int, default=64); p.add_argument("--epochs", type=int, default=60); p.add_argument("--lr", type=float, default=2e-3)
    a = p.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    Xtr, ytr, wtr = [t.to(dev) for t in load(a.train)]; Xte, yte, wte = [t.to(dev) for t in load(a.test)]
    torch.manual_seed(0)
    net = nn.Sequential(nn.Linear(Xtr.shape[1], a.hidden), nn.ReLU(), nn.Linear(a.hidden, a.hidden), nn.ReLU(), nn.Linear(a.hidden, 1), nn.Softplus()).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=a.lr)
    n = len(Xtr)
    for ep in range(a.epochs):
        perm = torch.randperm(n, device=dev)
        for i in range(0, n, 512):
            idx = perm[i:i + 512]; opt.zero_grad(); l = loss_fn(net(Xtr[idx]).squeeze(1), ytr[idx], wtr[idx]); l.backward(); opt.step()
        if ep % 10 == 9 or ep == a.epochs - 1:
            with torch.no_grad():
                pte = net(Xte).squeeze(1); m = wte > 0
                print(f"ep {ep+1} test loss {loss_fn(pte, yte, wte):.3f} winner MAE {(pte[m]-yte[m]).abs().mean():.2f} mean pred win {pte[m].mean():.1f} lose {pte[~m].mean():.1f} pred>paid on losses {(pte[~m]>yte[~m]).float().mean():.3f}", file=sys.stderr)
    layers = [{"w": l.weight.detach().cpu().tolist(), "b": l.bias.detach().cpu().tolist()} for l in net if isinstance(l, nn.Linear)]
    json.dump({"layers": layers, "features": "letter26,face/10,bag/68,min(cash,200)/100,score/100,racksize/10,rack26/3", "train": a.train}, open(a.out, "w"))

if __name__ == "__main__":
    main()
