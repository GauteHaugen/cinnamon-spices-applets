#!/usr/bin/env python3
"""Replay a saved Steam shader_log.txt into a fake log for testing the applet.

Lines are re-stamped with the current time as they are written, so the applet's
stall detection sees them as live. Pacing follows the original timestamps divided
by --speed.

Examples:
  dev/replay_log.py --point-applet                 # point the applet at the fake log
  dev/replay_log.py --app 550                      # one full run, 10x speed
  dev/replay_log.py --app 550 --since '2026-09-27 12:10:00'  # the post-driver-update run
  dev/replay_log.py --app 550 --stall-after 20     # pause 70 s after 20 progress ticks
  dev/replay_log.py --app 550 --truncate-after 20  # truncate the file mid-run
  dev/replay_log.py --app 550 --rotate-after 20    # replace the file like a Steam restart
  dev/replay_log.py --app 2868840 --app 1962700    # two games back to back
  dev/replay_log.py --point-applet --reset         # point the applet back at Steam's log
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
UUID = "devtest-SteamShaderStatus@GauteHaugen"
DEFAULT_FIXTURE = HERE / "fixtures" / "shader_log_2026-09-27.txt"
DEFAULT_OUT = "/tmp/fake_shader_log.txt"

TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ")
TS_FMT = "%Y-%m-%d %H:%M:%S"


def parse_ts(line):
    m = TS_RE.match(line)
    return datetime.strptime(m.group(1), TS_FMT) if m else None


def job_window(lines, appid, since=None):
    """Lines from the start of appid's first progress run (after since) to its completion."""
    progress = f"Still replaying {appid} ("
    first = next((i for i, l in enumerate(lines)
                  if progress in l and (since is None or parse_ts(l) >= since)), None)
    if first is None:
        sys.exit(f"No progress lines for app {appid} in fixture")

    starts = (f"Requeuing processing for app {appid}.",
              f"Starting processing job for app {appid}!",
              f"Starting replay of FOZ databases for AppID {appid} ")
    begin = next((i for i in range(first, -1, -1) if any(s in lines[i] for s in starts)), first)
    # Steam logs "Requeuing" right before "Starting processing job"; keep both.
    if begin > 0 and starts[0] in lines[begin - 1]:
        begin -= 1

    done = f"[ App ID {appid} ] fossilize_replay completed"
    end = next((i for i in range(first, len(lines)) if done in lines[i]), len(lines) - 1)
    # Include the "Destroyed compile job" that follows.
    if end + 1 < len(lines) and f"Destroyed compile job {appid}." in lines[end + 1]:
        end += 1
    return lines[begin:end + 1]


def config_files():
    base = Path.home() / ".config" / "cinnamon" / "spices" / UUID
    return [Path(p) for p in glob.glob(str(base / "*.json"))]


def point_applet(path):
    files = config_files()
    if not files:
        sys.exit("No applet config found. Add the applet to the panel first.")
    for f in files:
        data = json.loads(f.read_text())
        data.setdefault("log-path-override", {"type": "generic", "default": ""})
        data["log-path-override"]["value"] = path
        f.write_text(json.dumps(data, indent=4))
        print(f"{f}: log-path-override = {path!r}")
    # Cinnamon does not notice external edits to the settings file; reload the applet.
    subprocess.run(["dbus-send", "--session", "--dest=org.Cinnamon.LookingGlass", "--type=method_call",
                    "/org/Cinnamon/LookingGlass", "org.Cinnamon.LookingGlass.ReloadExtension",
                    f"string:{UUID}", "string:APPLET"], check=False)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--app", action="append", help="AppID to replay; repeat to chain games")
    ap.add_argument("--since", help="use the first run after this time, e.g. '2026-09-27 12:00:00'")
    ap.add_argument("--speed", type=float, default=10.0)
    ap.add_argument("--max-gap", type=float, default=5.0, help="cap on real seconds between lines")
    ap.add_argument("--stall-after", type=int, metavar="TICKS", help="pause --stall-seconds after N progress ticks")
    ap.add_argument("--stall-seconds", type=float, default=70.0)
    ap.add_argument("--truncate-after", type=int, metavar="TICKS", help="truncate the file after N progress ticks")
    ap.add_argument("--rotate-after", type=int, metavar="TICKS",
                    help="rename to shader_log.previous.txt and start a new file after N ticks")
    ap.add_argument("--point-applet", action="store_true", help="set the applet's hidden log path setting to --out")
    ap.add_argument("--reset", action="store_true", help="with --point-applet: clear the override")
    args = ap.parse_args()

    if args.point_applet:
        point_applet("" if args.reset else args.out)
        if not args.app:
            return

    if not args.app:
        ap.error("--app is required (e.g. --app 550)")

    lines = Path(args.fixture).read_text(encoding="utf-8", errors="replace").splitlines()
    out = Path(args.out)
    out.touch()

    ticks = 0
    for appid in args.app:
        since = datetime.strptime(args.since, TS_FMT) if args.since else None
        window = job_window(lines, appid, since)
        print(f"App {appid}: {len(window)} lines")
        prev = None
        for line in window:
            ts = parse_ts(line)
            if ts and prev:
                gap = min((ts - prev).total_seconds() / args.speed, args.max_gap)
                if gap > 0:
                    time.sleep(gap)
            if ts:
                prev = ts
                line = f"[{datetime.now().strftime(TS_FMT)}] " + line[TS_RE.match(line).end():]
            # Steam writes CRLF.
            with out.open("a", newline="") as f:
                f.write(line + "\r\n")

            if "Still replaying" not in line:
                continue
            ticks += 1
            print(f"  tick {ticks}: {line.strip()}")
            if ticks == args.stall_after:
                print(f"  -- stalling {args.stall_seconds:.0f} s")
                time.sleep(args.stall_seconds)
            if ticks == args.truncate_after:
                print("  -- truncating file")
                out.write_text("")
            if ticks == args.rotate_after:
                print("  -- rotating file")
                out.rename(out.with_name("shader_log.previous.txt"))
                out.touch()
    print("Done")


if __name__ == "__main__":
    main()
