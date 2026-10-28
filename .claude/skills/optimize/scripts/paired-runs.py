"""Time one command in a control and a treatment checkout, interleaved, and compare them.

Usage:
    python3 -I paired-runs.py --control DIR --treatment DIR [--pairs 10] [--warmup 1] -- COMMAND

COMMAND runs through `bash -c` with DIR as its working directory, so it can use the
checkout's own scripts. Pairs alternate their order (control first, then treatment
first) so drift on the machine hits both arms equally. Pass the same DIR twice for an
A/A run, which measures the noise floor.

Prints one line per pair and a summary: each arm's median, min and max, the median
paired difference (treatment minus control), and how many pairs the treatment won
with the one-sided sign-test p-value. Lower is better.

Exit codes: 0 done, 1 the command failed in an arm, 2 usage error.
"""

from __future__ import annotations

import argparse
import math
import statistics
import subprocess
import sys
import time


def run(command: str, cwd: str) -> float:
    start = time.monotonic()
    result = subprocess.run(
        ["bash", "-c", command], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
    )
    elapsed = (time.monotonic() - start) * 1000
    if result.returncode != 0:
        tail = "\n".join(result.stderr.strip().splitlines()[-10:])
        print(f"command exited {result.returncode} in {cwd}:\n{tail}", file=sys.stderr)
        sys.exit(1)
    return elapsed


def sign_test(wins: int, pairs: int) -> float:
    """P(at least `wins` of `pairs`) when each pair is a coin flip."""
    return sum(math.comb(pairs, k) for k in range(wins, pairs + 1)) / 2**pairs


def describe(name: str, values: list[float]) -> str:
    return f"{name:<9} median {statistics.median(values):.0f} ms (min {min(values):.0f}, max {max(values):.0f})"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--control", required=True)
    parser.add_argument("--treatment", required=True)
    parser.add_argument("--pairs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = " ".join(args.command[1:] if args.command[:1] == ["--"] else args.command)
    if not command or args.pairs < 1 or args.warmup < 0:
        parser.print_usage(sys.stderr)
        return 2

    arms = {"control": args.control, "treatment": args.treatment}
    for _ in range(args.warmup):
        for directory in arms.values():
            run(command, directory)

    times: dict[str, list[float]] = {"control": [], "treatment": []}
    for pair in range(1, args.pairs + 1):
        order = ["control", "treatment"] if pair % 2 else ["treatment", "control"]
        for arm in order:
            times[arm].append(run(command, arms[arm]))
        control, treatment = times["control"][-1], times["treatment"][-1]
        print(f"pair {pair}: control {control:.0f} ms, treatment {treatment:.0f} ms, diff {treatment - control:+.0f} ms")

    diffs = [t - c for c, t in zip(times["control"], times["treatment"])]
    wins = sum(1 for d in diffs if d < 0)
    print(describe("control", times["control"]))
    print(describe("treatment", times["treatment"]))
    print(f"paired diff median {statistics.median(diffs):+.0f} ms (treatment minus control)")
    print(f"treatment faster in {wins} of {args.pairs} pairs, one-sided sign test p = {sign_test(wins, args.pairs):.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
