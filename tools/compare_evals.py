"""Paired comparison of browser evaluations on the same seeds (exact two-sided McNemar test).

Same test as diffusion-pick's scripts/compare_paired.py, for tools/lab/run.cjs output:

    python tools/compare_evals.py results/browser_eval_dp_browser.json results/browser_eval_dp_v2.json
"""
import json
import sys
from math import comb
from pathlib import Path


def mcnemar_exact(b, c):
    n, k = b + c, min(b, c)
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)


def load(p):
    r = json.loads(Path(p).read_text())
    return Path(p).stem.replace("browser_eval_", ""), {e["seed"]: e["success"] for e in r["results"]}


def main():
    (na, a), (nb, b) = load(sys.argv[1]), load(sys.argv[2])
    assert a.keys() == b.keys(), "evaluations must use the same seeds"
    fixed = sorted(s for s in a if not a[s] and b[s])
    broke = sorted(s for s in a if a[s] and not b[s])
    p = mcnemar_exact(len(fixed), len(broke))
    print(f"| `{na}` | `{nb}` | fixed (A fail -> B success) | broken (A success -> B fail) | both fail | McNemar p |")
    print("|---|---|---|---|---|---|")
    print(f"| {sum(a.values())}/{len(a)} | {sum(b.values())}/{len(b)} | {len(fixed)} | {len(broke)} | "
          f"{sum(not a[s] and not b[s] for s in a)} | {p:.2g} |")
    print(f"fixed seeds: {fixed}\nbroken seeds: {broke}")


if __name__ == "__main__":
    main()
