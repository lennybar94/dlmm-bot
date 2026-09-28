#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sweep v4 — correction priorité real-monitor : value-stop AVANT recovery-exit,
TP et cooling AVANT OOR. Ordre prod (sections 1.5,2,6.5,7,5)."""
import sqlite3, itertools, sys, os, datetime, time, bisect, csv
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "..", "data", "dlmm-bot.db")
MONTH = "all"
for a in sys.argv:
    if a.startswith("--month="): MONTH = a.split("=", 1)[1]

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
db.row_factory = sqlite3.Row
POS = [dict(p) for p in db.execute(
    "SELECT id, opened_at, closed_at, pool_address, strategy, pilot, close_reason"
    " FROM real_positions WHERE status='closed'")]
tmp = defaultdict(list)
for r in db.execute("SELECT position_id, taken_at, net_pnl_usd, fees_usd, value_usd,"
                    " in_range FROM real_marks ORDER BY id"):
    tmp[r["position_id"]].append((r["taken_at"], r["net_pnl_usd"], r["fees_usd"],
                                  r["value_usd"], r["in_range"]))
MARKS = dict(tmp)
HARDSTOP = {p["id"] for p in POS if p["close_reason"] == "hard-stop"}
UNI = []
for p in POS:
    ms = MARKS.get(p["id"])
    if not ms or len(ms) < 5 or p["id"] in HARDSTOP: continue
    p["_month"] = datetime.datetime.utcfromtimestamp(p["closed_at"]/1000).strftime("%Y-%m")
    if MONTH != "all" and p["_month"] != MONTH: continue
    p["_ms"] = ms
    UNI.append(p)

VOL_T={}; VOL_V={}
cur=None; ts=[]; vs=[]
def flush():
    global cur,ts,vs
    if cur and len(ts)>=3: VOL_T[cur]=ts; VOL_V[cur]=vs
for r in db.execute("SELECT pool_address, scanned_at, volume_24h FROM pool_scans"
                    " WHERE volume_24h>0 ORDER BY pool_address, scanned_at"):
    if r["pool_address"]!=cur:
        flush(); cur=r["pool_address"]; ts=[]; vs=[]
    ts.append(r["scanned_at"]); vs.append(r["volume_24h"])
flush()
LOOKBACK=30*60_000; MINPEAK=10_000; CONSEC=2
CD=12*3600_000; EPS=1.0
def den(m): return m[3]+m[2]-m[1]

def cooling_fn(pool):
    times=VOL_T.get(pool); vol=VOL_V.get(pool)
    if not times: return None
    def fired(t, ratio):
        lo=bisect.bisect_left(times,t-LOOKBACK); hi=bisect.bisect_right(times,t)
        if hi-lo<3: return False
        per=[]
        for i in range(lo+1,hi):
            mins=(times[i]-times[i-1])/60_000; dl=vol[i]-vol[i-1]
            if mins>0 and dl>0: per.append(dl/mins)
        if len(per)<3: return False
        srt=sorted(per,reverse=True); peak=srt[1]
        if peak<MINPEAK: return False
        return all(x<ratio*peak for x in per[-CONSEC:])
    return fired

def simulate(pos, cfg, cache):
    """Ordre prod : hard-stop(skip) > value-stop > recovery > TP > cooling > OOR."""
    ms=pos["_ms"]
    is_dip=pos["strategy"] in ("bidask-dip","bidask-flip")
    pilot=bool(pos["pilot"])
    f=cooling_fn(pos["pool_address"]) if cfg["cool_ratio"] is not None else None
    last_fire={}; prev_net=None
    for idx,m in enumerate(ms):
        t,net,fees,value,in_range=m
        d=den(m); lr=(-net/d) if (d>0 and net<0) else 0.0
        def ready(k):
            if t-last_fire.get(k,0)<CD: return False
            last_fire[k]=t; return True
        # 1.5 value-stop
        if cfg["vstop"] is not None and lr>cfg["vstop"] and ready("vs"): return net,"value-stop"
        # 2 recovery-exit
        if is_dip and prev_net is not None and prev_net<-EPS and net>=0 and ready("rec"): return net,"recovery-exit"
        # 6.5 take-profit
        thr=(cfg["tp_pilot"] if pilot else cfg["tp_book"])
        if thr is not None and net>=thr and ready("tp"): return net,"take-profit"
        # 7 cooling-off
        if f is not None:
            key=(pos["pool_address"],t,cfg["cool_ratio"])
            cv=cache.get(key)
            if cv is None: cv=f(t,cfg["cool_ratio"]); cache[key]=cv
            if cv and ((not is_dip) or lr<cfg["cool_max_loss"]) and ready("cool"):
                return net,"cooling-off"
        # 5 OOR (book only)
        if cfg["oor_on"] and not in_range and not pilot:
            j=idx
            while j>=0 and not ms[j][4]: j-=1
            oor_h=(t-(ms[j][0] if j>=0 else pos["opened_at"]))/3600_000
            if net>=0 and oor_h>=6 and ready("redeploy"): return net,"oor-redeploy"
            if net<0 and oor_h>=cfg["oor_force_h"] and ready("force"): return net,"oor-force"
        prev_net=net
    return ms[-1][1],"hold-to-real-close"

def run(cfg):
    tot=0.0; book=0.0; pil=0.0; wins=0; reasons=defaultdict(int); cache={}
    for p in UNI:
        net,why=simulate(p,cfg,cache)
        tot+=net; wins+=net>0; reasons[why]+=1
        if p["pilot"]: pil+=net
        else: book+=net
    return dict(net=tot,book=book,pilot=pil,win=100*wins/len(UNI),reasons=dict(reasons))

CUR={"vstop":0.10,"tp_book":None,"tp_pilot":20,"oor_force_h":1,"cool_ratio":0.4,"cool_max_loss":0.15,"oor_on":True}
print(f"univers {MONTH}: {len(UNI)} positions", file=sys.stderr)
base=run(CUR)
print(f"CONFIG ACTUELLE simulée: net {base['net']:+.1f}$ (book {base['book']:+.1f}, pilote {base['pilot']:+.1f}), win {base['win']:.1f}%\n  {base['reasons']}", file=sys.stderr)

PAIRS=[
 ("vstop",[0.06,0.08,0.10,0.12,0.15,0.20,None], "tp_book",[None,10,15,20,30]),
 ("vstop",[0.06,0.08,0.10,0.12,0.15,0.20,None], "oor_force_h",[0.5,1,4,12,24,48]),
 ("vstop",[0.06,0.08,0.10,0.12,0.15,0.20,None], "cool_ratio",[None,0.25,0.4,0.6]),
 ("tp_book",[None,10,15,20,30], "oor_force_h",[0.5,1,4,12,24,48]),
 ("tp_book",[None,10,15,20,30], "cool_ratio",[None,0.25,0.4,0.6]),
 ("oor_force_h",[0.5,1,4,12,24,48], "cool_ratio",[None,0.25,0.4,0.6]),
 ("tp_pilot",[10,15,20,25,30,None], "vstop",[0.08,0.10,0.12,0.15]),
]
out=open(os.path.join(BASE,f"sweep_pairs_{MONTH}.csv"),"w",encoding="utf-8",newline="")
w=csv.writer(out); w.writerow(["pair","ax_name","ax_val","ay_name","ay_val","net_total","book","pilot","win_pct","reasons"])
for ax,avals,ay,ayvals in PAIRS:
    print(f"=== paire {ax} x {ay} ===")
    header=["\\"]+[f"{ay}={x}" for x in ayvals]
    print(" | ".join(f"{h:>12}" for h in header))
    for a in avals:
        row=[str(a)]
        for b in ayvals:
            cfg=dict(CUR); cfg[ax]=a; cfg[ay]=b
            r=run(cfg)
            row.append(f"{r['net']:+.0f}")
            w.writerow([f"{ax}x{ay}",ax,str(a),ay,str(b),round(r['net'],1),round(r['book'],1),round(r['pilot'],1),round(r['win'],1),str(r['reasons'])])
        print(" | ".join(f"{c:>12}" for c in row))
    print()
out.close()
print("CSV:", out.name, file=sys.stderr)
