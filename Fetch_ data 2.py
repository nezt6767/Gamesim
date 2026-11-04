#!/usr/bin/env python3
"""
Builds data.js for the simulator from the last ~2 seasons of real NBA + NHL stats.

Setup:   pip install nba_api requests
Run:     python fetch_data.py            (weekly: stats -> data.js, plus today.js)
         python fetch_data.py daily      (daily: today's games + injury/active status -> today.js)

Recent seasons are weighted more heavily (see SEASON_WEIGHTS). Adjust to taste.
NOTE: written against the public NBA Stats (nba_api) and NHL web API (api-web.nhle.com);
those endpoints change occasionally, so if a field is missing, check the field names below.
"""
import json, time, sys, os
from collections import defaultdict

# season label -> weight (most recent first). "Last 2 years" = current partial season + prior full season.
NBA_SEASONS = {"2026-27": 1.0, "2025-26": 1.0, "2024-25": 0.5}
NHL_SEASONS = {"20262027": 1.0, "20252026": 1.0, "20242025": 0.5}
TOP_N_NBA = 11


def wavg(pairs):
    tw = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / tw if tw else 0.0


# ---------------------------------------------------------------- NBA
def build_nba():
    from nba_api.stats.endpoints import leaguedashteamstats, leaguedashplayerstats
    from nba_api.stats.static import teams as nba_teams

    id2abbr = {t["id"]: t["abbreviation"] for t in nba_teams.get_teams()}
    team_acc = defaultdict(lambda: defaultdict(list))
    player_acc = {}
    latest_team = {}
    first = True
    for season, w in NBA_SEASONS.items():
        print("NBA", season)
        adv = leaguedashteamstats.LeagueDashTeamStats(
            season=season, measure_type_detailed_defense="Advanced", per_mode_detailed="PerGame"
        ).get_data_frames()[0]
        if adv.empty:
            continue
        gp_weight = w
        for _, r in adv.iterrows():
            ab = id2abbr.get(int(r["TEAM_ID"]), r["TEAM_NAME"])
            team_acc[ab]["name"] = r["TEAM_NAME"]
            weight = w * float(r["GP"])
            team_acc[ab]["ortg"].append((float(r["OFF_RATING"]), weight))
            team_acc[ab]["drtg"].append((float(r["DEF_RATING"]), weight))
            team_acc[ab]["pace"].append((float(r["PACE"]), weight))
        time.sleep(1)
        padv = leaguedashplayerstats.LeagueDashPlayerStats(
            season=season, measure_type_detailed_defense="Advanced", per_mode_detailed="PerGame"
        ).get_data_frames()[0]
        pbase = leaguedashplayerstats.LeagueDashPlayerStats(
            season=season, measure_type_detailed_defense="Base", per_mode_detailed="PerGame"
        ).get_data_frames()[0]
        base_by_id = {int(r["PLAYER_ID"]): r for _, r in pbase.iterrows()}
        for _, r in padv.iterrows():
            pid = int(r["PLAYER_ID"])
            b = base_by_id.get(pid)
            if b is None or float(b["FGA"]) < 1:
                continue
            weight = w * float(r["GP"]) * float(r["MIN"])
            fga, fg3a = float(b["FGA"]), float(b["FG3A"])
            fgm, fg3m = float(b["FGM"]), float(b["FG3M"])
            d = player_acc.setdefault(pid, defaultdict(list))
            d["name"] = r["PLAYER_NAME"]
            d["min"].append((float(r["MIN"]), w * float(r["GP"])))
            d["usg"].append((float(r["USG_PCT"]), weight))
            d["r3"].append((fg3a / fga, weight))
            d["fg3"].append((float(b["FG3_PCT"] or 0), w * float(b["FG3A"]) * float(r["GP"]) + 1e-6))
            two_a = fga - fg3a
            d["fg2"].append(((fgm - fg3m) / two_a if two_a > 0 else 0.5, w * two_a * float(r["GP"]) + 1e-6))
            if first or pid not in latest_team:
                latest_team[pid] = r["TEAM_ABBREVIATION"]
        first = False
        time.sleep(1)

    teams = {}
    for ab, d in team_acc.items():
        teams[ab] = {
            "name": d["name"], "ortg": wavg(d["ortg"]), "drtg": wavg(d["drtg"]), "pace": wavg(d["pace"]), "players": [],
        }
    for pid, d in player_acc.items():
        ab = latest_team.get(pid)
        if ab in teams and d["usg"]:
            teams[ab]["players"].append({
                "name": d["name"], "min": round(wavg(d["min"]), 1), "usg": round(wavg(d["usg"]), 3),
                "r3": round(wavg(d["r3"]), 3), "fg3": round(wavg(d["fg3"]), 3), "fg2": round(wavg(d["fg2"]), 3),
            })
    for t in teams.values():
        t["players"].sort(key=lambda p: -p["min"])
        t["players"] = t["players"][:TOP_N_NBA]
        for k in ("ortg", "drtg", "pace"):
            t[k] = round(t[k], 2)
    league_ortg = round(sum(t["ortg"] for t in teams.values()) / max(1, len(teams)), 2)
    return {"league": {"ortg": league_ortg}, "teams": teams}


# ---------------------------------------------------------------- NHL
def build_nhl():
    import requests

    base = "https://api-web.nhle.com/v1"
    standings = requests.get(f"{base}/standings/now", timeout=30).json()["standings"]
    abbrs = {s["teamAbbrev"]["default"]: s["teamName"]["default"] for s in standings}
    teams = {}
    league_shots, league_games, sv_num, sv_den = 0.0, 0.0, 0.0, 0.0
    for ab, name in abbrs.items():
        sk = defaultdict(lambda: defaultdict(float))
        gl = defaultdict(lambda: defaultdict(float))
        team_shots = team_sa = team_gp = 0.0
        for season, w in NHL_SEASONS.items():
            try:
                js = requests.get(f"{base}/club-stats/{ab}/{season}/2", timeout=30).json()
            except Exception as e:
                print("skip", ab, season, e); continue
            gp_max = 0
            for s in js.get("skaters", []):
                key = s["playerId"]
                gp = s.get("gamesPlayed", 0)
                gp_max = max(gp_max, gp)
                d = sk[key]
                d["name"] = (s["firstName"]["default"] + " " + s["lastName"]["default"])
                d["pos"] = s.get("positionCode", "F")
                d["shots"] += w * s.get("shots", 0)
                d["goals"] += w * s.get("goals", 0)
                d["gp"] += w * gp
                d["toi"] += w * gp * s.get("avgTimeOnIcePerGame", 0) / 60.0
                team_shots += w * s.get("shots", 0)
            for g in js.get("goalies", []):
                key = g["playerId"]
                d = gl[key]
                d["name"] = g["firstName"]["default"] + " " + g["lastName"]["default"]
                sa = g.get("shotsAgainst", 0)
                saves = g.get("saves", sa * (g.get("savePercentage", 0.9) or 0.9))
                d["sa"] += w * sa
                d["saves"] += w * saves
                d["gs"] += w * g.get("gamesStarted", 0)
                team_sa += w * sa
            team_gp += w * gp_max
            time.sleep(0.3)
        if team_gp == 0:
            continue
        players = []
        for d in sk.values():
            if d["gp"] < 5 or d["shots"] < 5:
                continue
            players.append({"name": d["name"], "pos": d["pos"], "sg": round(d["shots"] / d["gp"], 2),
                            "shPct": round(d["goals"] / d["shots"], 3), "toi": round(d["toi"] / d["gp"], 1)})
        players.sort(key=lambda p: -p["sg"])
        goalies = [{"name": d["name"], "sv": round(d["saves"] / d["sa"], 4), "gs": round(d["gs"], 1)}
                   for d in gl.values() if d["sa"] > 100]
        goalies.sort(key=lambda g: -g["gs"])
        if not players or not goalies:
            continue
        teams[ab] = {"name": name, "sfg": round(team_shots / team_gp, 2), "sag": round(team_sa / team_gp, 2),
                     "players": players[:16], "goalies": goalies[:3]}
        league_shots += team_shots; league_games += team_gp
        sv_num += sum(g["sv"] * g["gs"] for g in goalies); sv_den += sum(g["gs"] for g in goalies)
        print("NHL", ab)
    lg = {"sfg": round(league_shots / max(league_games, 1), 2), "sv": round(sv_num / max(sv_den, 1), 4)}
    return {"league": lg, "teams": teams}




# ---------------------------------------------------------------- Matchup data: home/road splits, head-to-head, style
SHRINK_SPLIT = 0.4   # fraction of a team's own home/road deviation that is trusted (splits are noisy)


def nba_matchup(teams, league):
    """Adds hO,hD,aO,aD, h2h, opp_fg3/opp_fg2/opp_r3 to NBA teams, and league fg3/fg2/r3."""
    from nba_api.stats.endpoints import leaguegamefinder, leaguedashteamstats
    from nba_api.stats.static import teams as nba_teams
    id2abbr = {t["id"]: t["abbreviation"] for t in nba_teams.get_teams()}
    games = defaultdict(lambda: defaultdict(float))   # (team, opp, home?) -> weighted sums
    tot = defaultdict(lambda: defaultdict(float))
    for season, w in NBA_SEASONS.items():
        df = leaguegamefinder.LeagueGameFinder(season_nullable=season, season_type_nullable="Regular Season",
                                               league_id_nullable="00").get_data_frames()[0]
        time.sleep(1)
        for _, r in df.iterrows():
            ab = r["TEAM_ABBREVIATION"]; m = r["MATCHUP"]
            home = " vs. " in m
            opp = m.split(" vs. ")[-1] if home else m.split(" @ ")[-1]
            pf = float(r["PTS"]); pa = pf - float(r["PLUS_MINUS"])
            for d in (games[(ab, opp)], tot[(ab, "H" if home else "R")], tot[(ab, "ALL")]):
                d["n"] += w; d["pf"] += w * pf; d["pa"] += w * pa
    # league per-game averages by venue
    lg_home_pf = sum(v["pf"] for (a, k), v in tot.items() if k == "H") / max(1e-9, sum(v["n"] for (a, k), v in tot.items() if k == "H"))
    lg_road_pf = sum(v["pf"] for (a, k), v in tot.items() if k == "R") / max(1e-9, sum(v["n"] for (a, k), v in tot.items() if k == "R"))
    lg_all = sum(v["pf"] for (a, k), v in tot.items() if k == "ALL") / max(1e-9, sum(v["n"] for (a, k), v in tot.items() if k == "ALL"))
    for ab, t in teams.items():
        al, hm, rd = tot[(ab, "ALL")], tot[(ab, "H")], tot[(ab, "R")]
        if not al["n"] or not hm["n"] or not rd["n"]:
            continue
        # deviation of own home/road scoring from (overall + league venue effect), shrunk
        t["hO"] = round(SHRINK_SPLIT * ((hm["pf"] / hm["n"] - al["pf"] / al["n"]) - (lg_home_pf - lg_all)), 2)
        t["hD"] = round(SHRINK_SPLIT * ((hm["pa"] / hm["n"] - al["pa"] / al["n"]) - (lg_road_pf - lg_all)), 2)
        t["aO"] = round(SHRINK_SPLIT * ((rd["pf"] / rd["n"] - al["pf"] / al["n"]) - (lg_road_pf - lg_all)), 2)
        t["aD"] = round(SHRINK_SPLIT * ((rd["pa"] / rd["n"] - al["pa"] / al["n"]) - (lg_home_pf - lg_all)), 2)
        t["h2h"] = {}
        for opp in teams:
            g = games.get((ab, opp)); og = tot.get((opp, "ALL"))
            if not g or not g["n"] or not og or not og["n"]:
                continue
            exp_pf = al["pf"] / al["n"] + og["pa"] / og["n"] - lg_all
            exp_pa = al["pa"] / al["n"] + og["pf"] / og["n"] - lg_all
            t["h2h"][opp] = {"n": round(g["n"], 1), "o": round(g["pf"] / g["n"] - exp_pf, 2),
                             "d": round(g["pa"] / g["n"] - exp_pa, 2)}
    # style: shooting allowed
    acc = defaultdict(lambda: defaultdict(list))
    for season, w in NBA_SEASONS.items():
        df = leaguedashteamstats.LeagueDashTeamStats(season=season, measure_type_detailed_defense="Opponent",
                                                     per_mode_detailed="PerGame").get_data_frames()[0]
        time.sleep(1)
        for _, r in df.iterrows():
            ab = id2abbr.get(int(r["TEAM_ID"]))
            wt = w * float(r["GP"])
            fga, fg3a, fgm, fg3m = float(r["OPP_FGA"]), float(r["OPP_FG3A"]), float(r["OPP_FGM"]), float(r["OPP_FG3M"])
            acc[ab]["fg3"].append((fg3m / fg3a if fg3a else .36, wt))
            acc[ab]["fg2"].append(((fgm - fg3m) / (fga - fg3a) if fga > fg3a else .54, wt))
            acc[ab]["r3"].append((fg3a / fga if fga else .38, wt))
    for ab, t in teams.items():
        if ab in acc:
            t["opp_fg3"] = round(wavg(acc[ab]["fg3"]), 4); t["opp_fg2"] = round(wavg(acc[ab]["fg2"]), 4)
            t["opp_r3"] = round(wavg(acc[ab]["r3"]), 4)
    vals = [t for t in teams.values() if "opp_fg3" in t]
    if vals:
        league["fg3"] = round(sum(t["opp_fg3"] for t in vals) / len(vals), 4)
        league["fg2"] = round(sum(t["opp_fg2"] for t in vals) / len(vals), 4)
        league["r3"] = round(sum(t["opp_r3"] for t in vals) / len(vals), 4)


def nhl_matchup(teams, league):
    """Adds hf,ha,af,aa (home/road goal-rate factors) and h2h (goals/game residuals) to NHL teams."""
    import requests
    base = "https://api-web.nhle.com/v1"
    standings = requests.get(f"{base}/standings/now", timeout=30).json()["standings"]
    st = {s["teamAbbrev"]["default"]: s for s in standings}
    lg = defaultdict(float)
    for s in st.values():
        lg["hgf"] += s.get("homeGoalsFor", 0); lg["hga"] += s.get("homeGoalsAgainst", 0)
        lg["rgf"] += s.get("roadGoalsFor", 0); lg["rga"] += s.get("roadGoalsAgainst", 0)
        lg["hgp"] += s.get("homeGamesPlayed", 0); lg["rgp"] += s.get("roadGamesPlayed", 0)
    lg_h = lg["hgf"] / max(1, lg["hgp"]); lg_r = lg["rgf"] / max(1, lg["rgp"])
    lg_all = (lg["hgf"] + lg["rgf"]) / max(1, lg["hgp"] + lg["rgp"])
    league["gpg"] = round(lg_all, 3)
    for ab, t in teams.items():
        s = st.get(ab)
        if not s or not s.get("homeGamesPlayed") or not s.get("roadGamesPlayed"):
            continue
        hgp, rgp = s["homeGamesPlayed"], s["roadGamesPlayed"]
        gp = hgp + rgp
        all_gf = (s["homeGoalsFor"] + s["roadGoalsFor"]) / gp; all_ga = (s["homeGoalsAgainst"] + s["roadGoalsAgainst"]) / gp
        k = SHRINK_SPLIT
        dev = lambda x, base_, venue: 1 + k * ((x / base_) / (venue / lg_all) - 1)
        t["hf"] = round(dev(s["homeGoalsFor"] / hgp, all_gf, lg_h), 3)
        t["ha"] = round(dev(s["homeGoalsAgainst"] / hgp, all_ga, lg_r), 3)
        t["af"] = round(dev(s["roadGoalsFor"] / rgp, all_gf, lg_r), 3)
        t["aa"] = round(dev(s["roadGoalsAgainst"] / rgp, all_ga, lg_h), 3)
    # head-to-head from season schedules
    res = defaultdict(lambda: defaultdict(float)); tot = defaultdict(lambda: defaultdict(float))
    for ab in teams:
        for season, w in NHL_SEASONS.items():
            try:
                js = requests.get(f"{base}/club-schedule-season/{ab}/{season}", timeout=30).json()
            except Exception as e:
                print("sched skip", ab, season, e); continue
            for g in js.get("games", []):
                if g.get("gameType") != 2 or g.get("gameState") not in ("FINAL", "OFF"):
                    continue
                home = g["homeTeam"]["abbrev"] == ab
                me, op = (g["homeTeam"], g["awayTeam"]) if home else (g["awayTeam"], g["homeTeam"])
                gf, ga = me.get("score", 0), op.get("score", 0)
                for d in (res[(ab, op["abbrev"])], tot[ab]):
                    d["n"] += w; d["gf"] += w * gf; d["ga"] += w * ga
            time.sleep(0.2)
    for ab, t in teams.items():
        t["h2h"] = {}
        a = tot.get(ab)
        for opp in teams:
            g = res.get((ab, opp)); o = tot.get(opp)
            if not g or not g["n"] or not a or not a["n"] or not o or not o["n"]:
                continue
            exp = a["gf"] / a["n"] + o["ga"] / o["n"] - lg_all
            expd = a["ga"] / a["n"] + o["gf"] / o["n"] - lg_all
            t["h2h"][opp] = {"n": round(g["n"], 1), "o": round(g["gf"] / g["n"] - exp, 2), "d": round(g["ga"] / g["n"] - expd, 2)}

# ---------------------------------------------------------------- DAILY: schedule + injuries (ESPN public API)
# Unofficial endpoints (may change). Run this every day; it only writes today.js.
ESPN = "https://site.api.espn.com/apis/site/v2/sports"
ALIASES = {  # ESPN abbreviation -> abbreviation used in data.js
    "nba": {"GS": "GSW", "NY": "NYK", "SA": "SAS", "NO": "NOP", "UTAH": "UTA", "WSH": "WAS", "PHX": "PHX"},
    "nhl": {"TB": "TBL", "NJ": "NJD", "SJ": "SJS", "LA": "LAK", "WSH": "WSH", "UTAH": "UTA"},
}


def fetch_daily():
    import requests
    from datetime import datetime, timedelta
    out = {"updated": datetime.now().isoformat(timespec="minutes"), "nba": {"games": [], "injuries": {}},
           "nhl": {"games": [], "injuries": {}}}
    for sport, path in (("nba", "basketball/nba"), ("nhl", "hockey/nhl")):
        al = ALIASES[sport]
        fix = lambda a: al.get(a, a)
        # schedule: today + next 2 days
        for d in range(3):
            day = (datetime.now() + timedelta(days=d)).strftime("%Y%m%d")
            try:
                js = requests.get(f"{ESPN}/{path}/scoreboard", params={"dates": day}, timeout=30).json()
            except Exception as e:
                print("scoreboard fail", sport, day, e); continue
            for ev in js.get("events", []):
                comp = ev["competitions"][0]
                teams = {c["homeAway"]: fix(c["team"]["abbreviation"]) for c in comp["competitors"]}
                out[sport]["games"].append({"date": ev.get("date"), "home": teams.get("home"), "away": teams.get("away"),
                                            "state": ev.get("status", {}).get("type", {}).get("state", "pre")})
        # injuries / inactive status
        try:
            js = requests.get(f"{ESPN}/{path}/injuries", timeout=30).json()
            for team in js.get("injuries", []):
                abbr = None
                items = team.get("injuries", [])
                for it in items:
                    ath = it.get("athlete", {})
                    abbr = abbr or fix(ath.get("team", {}).get("abbreviation") or "") or None
                tname = team.get("displayName", "")
                out[sport]["injuries"][tname] = [
                    {"name": it.get("athlete", {}).get("displayName", ""), "status": it.get("status", ""),
                     "note": (it.get("shortComment") or "")[:140], "abbr": abbr}
                    for it in items]
        except Exception as e:
            print("injuries fail", sport, e)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "today.js")
    with open(path, "w") as f:
        f.write("window.SIM_TODAY = " + json.dumps(out) + ";\n")
    print("Wrote", path, {k: len(out[k]["games"]) for k in ("nba", "nhl")})


def load_existing(path):
    try:
        txt = open(path).read()
        return json.loads(txt[txt.index("=") + 1:].strip().rstrip(";"))
    except Exception:
        return {}


def main(args):
    if args == ["daily"]:
        fetch_daily(); return
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "data.js")
    existing = load_existing(path)
    out = {"generated": time.strftime("%Y-%m-%d"), "demo": False, "demoSports": []}
    which = args or ["nba", "nhl"]
    jobs = (("nba", build_nba, nba_matchup), ("nhl", build_nhl, nhl_matchup))
    for sport, builder, matchup in jobs:
        if sport not in which:
            if existing.get(sport):
                out[sport] = existing[sport]
            continue
        try:
            out[sport] = builder()
            try:
                matchup(out[sport]["teams"], out[sport]["league"])
            except Exception as e:
                print(sport.upper(), "matchup data skipped:", e)
        except Exception as e:
            # Keep going: one sport failing (e.g. NBA stats site blocking cloud servers) must not stop the rest.
            print(sport.upper(), "stats FAILED, keeping previous data:", repr(e)[:300])
            if existing.get(sport):
                out[sport] = existing[sport]
                if existing.get("demo") or sport in existing.get("demoSports", []):
                    out["demoSports"].append(sport)
            else:
                out["demoSports"].append(sport)
    with open(path, "w") as f:
        f.write("window.SIM_DATA = " + json.dumps(out) + ";\n")
    print("Wrote", path, "demo sports:", out["demoSports"])
    try:
        fetch_daily()
    except Exception as e:
        print("daily refresh failed:", repr(e)[:300])


if __name__ == "__main__":
    main(sys.argv[1:])
