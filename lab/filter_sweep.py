#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sweep v2 des filtres de SORTIE du bot DLMM — rejoue mark-à-mark l'historique
réel (real_marks) en respectant la priorité du real-monitor :
  hard-stop > value-stop > recovery-exit > OOR > take-profit > cooling-off
+ cooldown 12 h par type/position (dédup réel-monitor).

Filtres balayés autour des valeurs actuelles :
  VALUE_STOP_LOSS (0.10), BOOK_TAKE_PROFIT_USD (off), PILOT_TAKE_PROFIT_USD (20),
  REAL_OOR_FORCE_CLOSE_HOURS (1), COOLING_RATIO (0.4)

Usage : python3 lab/filter_sweep.py --month=all|2026-08|2026-09
Sortie : lab/sweep_results_<month>.csv
"""
import sqlite3, itertools, json, sys, os, bisect, datetime
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "..", "data", "dlmm-bot.db")

MONTH_FILTER = "all"
for a in sys.argv:
    if a.startswith("--month="):
        MONTH_FILTER = a.split("=", 1)[1]
OUT = os.path.join(BASE, f"sweep_results_{MONTH_FILTER}.csv")

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
db.row_factory = sqlite3.Row

POS = [dict(p) for p in db.execute(
    "SELECT id, opened_at, closed_at, pool_address, name, strategy, deposit_usd,"
    " amount_y, invested_sol, pilot, close_reason FROM real_positions"
    " WHERE status='closed' ORDER BY opened_at")]

MARKS = {}
tmp = defaultdict(list)
for r in db.execute(
    "SELECT position_id, taken_at, net_pnl_usd, fees_usd, value_usd, in_range"
    " FROM real_marks ORDER BY id"):
    tmp[r["position_id"]].append((r["taken_at"], r["net_pnl_usd"], r["fees_usd"],
                                  r["value_usd"], r["in_range"]))
MARKS = dict(tmp)

# ---- série volume par pool (cooling-off) : arrays + index pour bisect ----
VOL_T = {}; VOL_V = {}
cur_pool = None; ts=[]; vs=[]
def flush():
    if cur_pool and len(ts) >= 3:
        VOL_T[cur_pool] = ts; VOL_V[cur_pool] = vs
for r in db.execute("SELECT pool_address, scanned_at, volume_24h FROM pool_scans"
                    " WHERE volume_24h > 0 ORDER BY pool_address, scanned_at"):
    if r["pool_address"] != cur_pool:
        flush(); cur_pool = r["pool_address"]; ts=[]; vs=[]
    ts.append(r["scanned_at"]); vs.append(r["volume_24h"])
flush()
print(f"pools avec série volume: {len(VOL_T)}", file=sys.stderr)

LOOKBACK_MS = 30 * 60_000
MIN_PEAK = 10_000
CONSEC = 2

def cooling_fired(pool, t_ms, ratio):
    times = VOL_T.get(pool)
    if not times: return False
    vol = VOL_V[pool]
    lo = bisect.bisect_left(times, t_ms - LOOKBACK_MS)
    hi = bisect.bisect_right(times, t_ms)
    n = hi - lo
    if n < 3: return False
    per = []
    for i in range(lo + 1, hi):
        minutes = (times[i] - times[i-1]) / 60_000
        delta = vol[i] - vol[i-1]
        if minutes > 0 and delta > 0:
            per.append(delta / minutes)
    if len(per) < 3: return False
    srt = sorted(per, reverse=True)
    peak = srt[1]
    if peak < MIN_PEAK: return False
    thr = ratio * peak
    return all(d < thr for d in per[-CONSEC:])

# dénominateur exact refSol*usd(t) = value+fees-net (définition du mark)
def den(m): return m[3] + m[2] - m[1]

HARDSTOP_IDS = {p["id"] for p in POS if p["close_reason"] == "hard-stop"}
RECOVERY_EPS = 1.0
CD = 12 * 3600_000  # cooldown 12h/type/position (miroir prod)

def simulate(pos, ms, cfg):
    is_dip = pos["strategy"] in ("bidask-dip", "bidask-flip")
    pilot = bool(pos["pilot"])
    last_fire = {}   # reason -> t
    prev_net = None
    cool_cache = {}  # mark-index -> bool (indépendant de ratio? non: dépend ratio) -> cache par ratio passé via closure
    for idx, m in enumerate(ms):
        t, net, fees, value, in_range = m
        d = den(m)
        loss_ratio = (-net / d) if (d > 0 and net < 0) else 0.0

        def ready(key):
            if t - last_fire.get(key, 0) < CD: return False
            last_fire[key] = t; return True

        # value-stop
        if cfg["vs_on"] and loss_ratio > cfg["vstop"] and ready("value-stop"):
            return (net, "value-stop")
        # recovery-exit
        if (is_dip and prev_net is not None and prev_net < -RECOVERY_EPS
                and net >= 0 and ready("recovery-exit")):
            return (net, "recovery-exit")
        # OOR (book only)
        if cfg["oor_on"] and not in_range and not pilot:
            j = idx
            while j >= 0 and not ms[j][4]: j -= 1
            oor_since = ms[j][0] if j >= 0 else pos["opened_at"]
            oor_h = (t - oor_since) / 3600_000
            if net >= 0 and oor_h >= 6 and ready("oor-redeploy"):
                return (net, "oor-redeploy")
            if net < 0 and oor_h >= cfg["oor_force_h"] and ready("oor-force"):
                return (net, "oor-force")
        # take-profit
        if cfg["tp_on"]:
            thr = cfg["tp_pilot"] if pilot else cfg["tp_book"]
            if net >= thr and ready("take-profit"):
                return (net, "take-profit")
        # cooling-off
        if cfg["cool_on"]:
            ck = idx
            if ck not in cool_cache:
                cool_cache[ck] = cooling_fired(pos["pool_address"], t, cfg["cool_ratio"])
            if cool_cache[ck]:
                if (not is_dip or loss_ratio < cfg["cool_max_loss"]) and ready("cooling-off"):
                    return (net, "cooling-off")
        prev_net = net
    return (ms[-1][1], "hold-to-real-close")

GRID_VS   = [0.06, 0.08, 0.10, 0.12, 0.15, 0.20, 999]
GRID_TPB  = [10, 15, 20, 30, 999]          # book TP (actuel prod: off/999)
GRID_TPP  = [15, 20, 25, 30, 999]          # pilote L4-B (actuel 20)
GRID_OOR  = [0.5, 1, 4, 12, 24, 48]        # heures grace sous l'eau (actuel 1)
GRID_COOL = [0.25, 0.4, 0.6, 999]          # actuel 0.4

def universe():
    out = []
    for p in POS:
        ms = MARKS.get(p["id"])
        if not ms or len(ms) < 5 or p["id"] in HARDSTOP_IDS: continue
        p["_month"] = datetime.datetime.utcfromtimestamp(p["closed_at"]/1000).strftime("%Y-%m")
        if MONTH_FILTER != "all" and p["_month"] != MONTH_FILTER: continue
        out.append(p)
    return out

UNI = universe()
mo = defaultdict(int)
for p in UNI: mo[p["_month"]] += 1
print(f"univers rejouable: {len(UNI)} ({dict(mo)})", file=sys.stderr)

combos = list(itertools.product(GRID_VS, GRID_TPB, GRID_TPP, GRID_OOR, GRID_COOL))
print(f"combos: {len(combos)}", file=sys.stderr)

rows = []
for ci, (vi, tb, tp, ofh, cr) in enumerate(combos):
    cfg = dict(vstop=vi, tp_book=tb, tp_pilot=tp, oor_force_h=ofh, cool_ratio=cr,
               vs_on=vi < 900, tp_on=True, oor_on=True, cool_on=cr < 900,
               cool_max_loss=0.15)
    tot = 0.0; book = 0.0; pil = 0.0; wins = 0; reasons = defaultdict(int)
    for p in UNI:
        net, why = simulate(p, MARKS[p["id"]], cfg)
        tot += net; wins += net > 0; reasons[why] += 1
        if p["pilot"]: pil += net
        else: book += net
    rows.append(dict(value_stop=vi, tp_book=tb, tp_pilot=tp, oor_force_h=ofh,
                     cool_ratio=cr, net_total=round(tot,1), book=round(book,1),
                     pilot=round(pil,1), win_pct=round(100*wins/len(UNI),1),
                     reasons=json.dumps(dict(reasons))))
    if ci % 100 == 0: print(f"  {ci}/{len(combos)}", file=sys.stderr)

with open(OUT, "w", newline="", encoding="utf-8") as f:
    w = csv_writer = __import__("csv").DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
print(f"écrit {len(rows)} lignes -> {OUT}", file=sys.stderr)
