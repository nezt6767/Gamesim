// Monte Carlo engines for NBA (possession-based) and NHL (shot-based).
// Works in the browser (window.Sim) and in Node (module.exports).
(function (root) {
  // ---------- RNG helpers ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randn(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function poisson(lambda, rng) {
    if (lambda <= 0) return 0;
    if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn(rng)));
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }
  function cumulative(weights) {
    const cum = []; let s = 0;
    for (const w of weights) { s += w; cum.push(s); }
    return { cum, total: s };
  }
  function pick(c, rng) {
    const r = rng() * c.total;
    let lo = 0, hi = c.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (c.cum[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));


  // ---------- Matchup helpers (home/away splits, head-to-head, style) ----------
  // Team fields (all optional; missing = no adjustment):
  //   NBA: hO,hD (home offense/defense deviation, pts/100, shrunk), aO,aD (road), h2h:{OPP:{n,o,d}} (pts/game residuals vs that opp)
  //        opp_fg3, opp_fg2, opp_r3 (shooting allowed). league: {ortg, fg3, fg2, r3}
  //   NHL: hf,ha,af,aa (home/road goal-rate factors, ~1.0), h2h:{OPP:{n,o,d}} (goals/game residuals)
  const H2H_K = 8; // shrinkage: n/(n+8) of the observed head-to-head residual is used
  function h2hOf(team, key) {
    const r = team.h2h && key ? team.h2h[key] : null;
    if (!r || !r.n) return { v: 0, n: 0, raw: 0 };
    return { v: r.o * r.n / (r.n + H2H_K), n: r.n, raw: r.o };
  }
  const cl = (x, a, b) => Math.min(b, Math.max(a, x));
  function styleTeam(team, opp, lg) {
    // Re-weights a roster's shot profile against how the opponent defends: threes vs teams that allow threes, etc.
    if (!opp.opp_fg3 || !lg || !lg.fg3) return { team, f: null };
    const f3 = cl(opp.opp_fg3 / lg.fg3, 0.88, 1.12), f2 = cl((opp.opp_fg2 || lg.fg2) / lg.fg2, 0.9, 1.1), fr = cl((opp.opp_r3 || lg.r3) / lg.r3, 0.9, 1.1);
    const players = team.players.map(p => Object.assign({}, p, { fg3: p.fg3 * f3, fg2: p.fg2 * f2, r3: cl(p.r3 * fr, 0, 0.9) }));
    return { team: Object.assign({}, team, { players }), f: { f3, f2, fr } };
  }
  function nbaMods(home, away, opts) {
    const on = opts.useMatchup !== false, lgs = opts.leagueStyle || {};
    const hs = on ? styleTeam(home, away, lgs) : { team: home, f: null };
    const as = on ? styleTeam(away, home, lgs) : { team: away, f: null };
    const hh = on ? h2hOf(home, opts.awayKey) : { v: 0, n: 0, raw: 0 }, ah = on ? h2hOf(away, opts.homeKey) : { v: 0, n: 0, raw: 0 };
    const addH = on ? (home.hO || 0) + (away.aD || 0) + hh.v : 0;
    const addA = on ? (away.aO || 0) + (home.hD || 0) + ah.v : 0;
    return { homeT: hs.team, awayT: as.team, addH, addA,
      factors: { on, splitsH: on ? (home.hO || 0) + (away.aD || 0) : 0, splitsA: on ? (away.aO || 0) + (home.hD || 0) : 0,
        h2hHome: hh, h2hAway: ah, styleHome: hs.f, styleAway: as.f } };
  }
  function nhlMods(home, away, opts) {
    const on = opts.useMatchup !== false, gpg = (opts.league && opts.league.gpg) || 3.0;
    const hh = on ? h2hOf(home, opts.awayKey) : { v: 0, n: 0, raw: 0 }, ah = on ? h2hOf(away, opts.homeKey) : { v: 0, n: 0, raw: 0 };
    const mH = on ? cl((home.hf || 1) * (away.aa || 1) * (1 + hh.v / gpg), 0.8, 1.25) : 1;
    const mA = on ? cl((away.af || 1) * (home.ha || 1) * (1 + ah.v / gpg), 0.8, 1.25) : 1;
    return { mH, mA, factors: { on, mH, mA, h2hHome: hh, h2hAway: ah } };
  }

  // ---------- NBA ----------
  // team: {name, ortg, drtg, pace, players:[{name, min, usg, r3, fg3, fg2}]}
  // opts: {n, seed, hca (pts/100 each side), noise (pts/100 sd), outHome:Set, outAway:Set, leagueOrtg}
  function wOf(p) { return Math.max(0.01, p.usg) * Math.max(0.2, p.min / 36); }
  function prepNbaSide(team, out, replFactor) {
    const all = team.players;
    const active = all.filter(p => !out.has(p.name));
    const act = active.length ? active : all;
    const base = pppOf(all);
    const activeAvg = pppOf(act);
    // Missing players are replaced by replacement-level production (replFactor x team baseline),
    // so losing a high-usage, efficient player lowers the team's expected efficiency.
    const totW = all.reduce((s, p) => s + wOf(p), 0);
    const actW = act.reduce((s, p) => s + wOf(p), 0);
    const removedW = Math.max(0, totW - actW);
    const eff = (actW * activeAvg + removedW * base * replFactor) / totW; // ppp incl. replacements
    return { players: act, cum: cumulative(act.map(wOf)), baseline: base, activeAvgPpp: activeAvg,
      injuryFactor: eff / base, allCount: all.length, activeCount: act.length };
  }
  function pppOf(players) {
    let num = 0, den = 0;
    for (const p of players) {
      const w = Math.max(0.01, p.usg) * Math.max(0.2, p.min / 36);
      num += w * (p.r3 * 3 * p.fg3 + (1 - p.r3) * 2 * p.fg2);
      den += w;
    }
    return den ? num / den : 1;
  }
  function nbaGame(A, B, adjA, adjB, poss, rng, stats, sideA, sideB) {
    // returns [scoreA, scoreB]; stats accumulates player points
    let sa = 0, sb = 0;
    for (let i = 0; i < poss; i++) {
      sa += nbaPossession(A, adjA, rng, stats.a);
      sb += nbaPossession(B, adjB, rng, stats.b);
    }
    return [sa, sb];
  }
  function nbaPossession(side, adjOrtg, rng, pts) {
    const i = pick(side.cum, rng);
    side.last = i;
    const p = side.players[i];
    // scale shooting so that a roster-average possession yields adjOrtg/100 points
    const m = (adjOrtg / 100) / side.activeAvgPpp;
    const is3 = rng() < p.r3;
    const prob = clamp((is3 ? p.fg3 : p.fg2) * m, 0.03, 0.85);
    if (rng() < prob) {
      const v = is3 ? 3 : 2;
      pts[i] += v;
      return v;
    }
    return 0;
  }
  function simulateNBA(home, away, opts) {
    const n = opts.n || 10000;
    const rng = mulberry32(opts.seed || (Date.now() & 0xffffffff));
    const hca = opts.hca == null ? 1.5 : opts.hca;
    const noise = opts.noise == null ? 2.5 : opts.noise;
    const lg = opts.leagueOrtg || 114;
    const repl = opts.replFactor == null ? 0.88 : opts.replFactor;
    const M = nbaMods(home, away, opts);
    const H = prepNbaSide(M.homeT, opts.outHome || new Set(), repl);
    const A = prepNbaSide(M.awayT, opts.outAway || new Set(), repl);
    // injury effect on efficiency: ratio of active-roster ppp to full-roster ppp
    const injH = H.injuryFactor;
    const injA = A.injuryFactor;
    const pace = (home.pace + away.pace) / 2;
    const res = { n, homeWins: 0, awayWins: 0, ot: 0, margins: new Array(n), totals: new Array(n), hs: 0, as: 0,
      homePts: new Float64Array(H.players.length), awayPts: new Float64Array(A.players.length),
      homePlayers: H.players.map(p => p.name), awayPlayers: A.players.map(p => p.name) };
    for (let g = 0; g < n; g++) {
      const baseH = (home.ortg + away.drtg - lg) * 1; // adjusted offense per 100
      const baseA = (away.ortg + home.drtg - lg) * 1;
      const oH = baseH + hca * 0.5 + M.addH + noise * randn(rng) + 100 * (injH - 1);
      const oA = baseA - hca * 0.5 + M.addA + noise * randn(rng) + 100 * (injA - 1);
      const poss = Math.round(pace + randn(rng) * 2.5);
      const stats = { a: res.homePts, b: res.awayPts };
      let [sh, sa] = nbaGame(H, A, oH, oA, poss, rng, stats);
      let overtime = 0;
      while (sh === sa && overtime < 6) {
        overtime++;
        const otPoss = Math.max(8, Math.round(poss * 5 / 48));
        const [x, y] = nbaGame(H, A, oH, oA, otPoss, rng, stats);
        sh += x; sa += y;
      }
      if (overtime) res.ot++;
      if (sh > sa) res.homeWins++; else if (sa > sh) res.awayWins++; else { if (rng() < 0.5) res.homeWins++; else res.awayWins++; }
      res.margins[g] = sh - sa;
      res.totals[g] = sh + sa;
      res.hs += sh; res.as += sa;
    }
    res.homeWinPct = res.homeWins / n;
    res.avgHome = res.hs / n; res.avgAway = res.as / n;
    res.avgMargin = res.avgHome - res.avgAway;
    res.avgTotal = res.avgHome + res.avgAway;
    res.otPct = res.ot / n;
    res.homePlayerAvg = Array.from(res.homePts, v => v / n);
    res.awayPlayerAvg = Array.from(res.awayPts, v => v / n);
    res.factors = M.factors;
    res.warnings = [];
    if (H.activeCount < 7) res.warnings.push(home.name + ' has few active players listed.');
    if (A.activeCount < 7) res.warnings.push(away.name + ' has few active players listed.');
    return res;
  }

  // ---------- NHL ----------
  // team: {name, sfg, sag, gfg, players:[{name, pos, sg (shots/gm), shPct, toi}], goalies:[{name, sv, gs}]}
  // opts: {n, seed, hca, outHome, outAway, goalieHome, goalieAway, league:{sfg, sv, shPct}}
  function prepNhlSide(team, out, goalieName) {
    const all = team.players;
    const active = all.filter(p => !out.has(p.name));
    const wAll = all.reduce((s, p) => s + p.sg, 0);
    const wAct = active.reduce((s, p) => s + p.sg, 0);
    const goalie = (team.goalies.find(g => g.name === goalieName) || team.goalies[0]);
    return { players: active.length ? active : all, cum: cumulative((active.length ? active : all).map(p => p.sg)),
      shotScale: wAll ? Math.max(0.5, wAct / wAll) : 1, goalie };
  }
  function simulateNHL(home, away, opts) {
    const n = opts.n || 10000;
    const rng = mulberry32(opts.seed || (Date.now() & 0xffffffff));
    const hca = opts.hca == null ? 0.03 : opts.hca; // fraction boost to home shot rate
    const lg = opts.league || { sfg: 30, sv: 0.905 };
    const M = nhlMods(home, away, opts);
    const H = prepNhlSide(home, opts.outHome || new Set(), opts.goalieHome);
    const A = prepNhlSide(away, opts.outAway || new Set(), opts.goalieAway);
    const res = { n, homeWins: 0, awayWins: 0, regHome: 0, regAway: 0, otHome: 0, otAway: 0, soHome: 0, soAway: 0,
      hg: 0, ag: 0, margins: new Array(n), totals: new Array(n),
      homeGoals: new Float64Array(H.players.length), awayGoals: new Float64Array(A.players.length),
      homeScored: new Float64Array(H.players.length), awayScored: new Float64Array(A.players.length),
      homePlayers: H.players.map(p => p.name), awayPlayers: A.players.map(p => p.name) };
    const lgFail = 1 - lg.sv;
    function shoot(side, opp, rate, rng, goalsArr, scoredFlags) {
      const shots = poisson(rate, rng);
      let goals = 0;
      const failFactor = (1 - opp.goalie.sv) / lgFail;
      for (let s = 0; s < shots; s++) {
        const i = pick(side.cum, rng);
        const p = side.players[i];
        const prob = clamp(p.shPct * failFactor, 0.01, 0.4);
        if (rng() < prob) { goals++; goalsArr[i]++; scoredFlags[i] = 1; }
      }
      return goals;
    }
    const sfH0 = (home.sfg + away.sag) / 2, sfA0 = (away.sfg + home.sag) / 2;
    const flagsH = new Uint8Array(H.players.length), flagsA = new Uint8Array(A.players.length);
    for (let g = 0; g < n; g++) {
      flagsH.fill(0); flagsA.fill(0);
      // game-level noise on shot volume (pace / game script)
      const nH = Math.exp(0.12 * randn(rng)), nA = Math.exp(0.12 * randn(rng));
      const rH = sfH0 * H.shotScale * (1 + hca) * nH * M.mH;
      const rA = sfA0 * A.shotScale * (1 - hca) * nA * M.mA;
      let gh = shoot(H, A, rH, rng, res.homeGoals, flagsH);
      let ga = shoot(A, H, rA, rng, res.awayGoals, flagsA);
      let kind = 'reg';
      if (gh === ga) {
        // 3-on-3 overtime: sudden death, 5 minutes, goal rate ~ 1.8x
        const lamH = (rH / 60) * 0.12 * 1.8 * 0.95, lamA = (rA / 60) * 0.12 * 1.8 * 0.95; // per minute goals (approx)
        const tH = -Math.log(1 - rng()) / Math.max(lamH, 1e-6), tA = -Math.log(1 - rng()) / Math.max(lamA, 1e-6);
        if (Math.min(tH, tA) <= 5) {
          kind = 'ot';
          if (tH < tA) { gh++; const i = pick(H.cum, rng); res.homeGoals[i]++; flagsH[i] = 1; }
          else { ga++; const i = pick(A.cum, rng); res.awayGoals[i]++; flagsA[i] = 1; }
        } else {
          kind = 'so';
          const pH = clamp(0.5 + 0.5 * ((1 - A.goalie.sv) / (1 - H.goalie.sv) - 1) * 0.15, 0.35, 0.65);
          if (rng() < pH) gh++; else ga++;
        }
      }
      for (let i = 0; i < flagsH.length; i++) res.homeScored[i] += flagsH[i];
      for (let i = 0; i < flagsA.length; i++) res.awayScored[i] += flagsA[i];
      const hw = gh > ga;
      if (hw) res.homeWins++; else res.awayWins++;
      if (kind === 'reg') { if (hw) res.regHome++; else res.regAway++; }
      else if (kind === 'ot') { if (hw) res.otHome++; else res.otAway++; }
      else { if (hw) res.soHome++; else res.soAway++; }
      res.hg += gh; res.ag += ga;
      res.margins[g] = gh - ga; res.totals[g] = gh + ga;
    }
    res.homeWinPct = res.homeWins / n;
    res.avgHome = res.hg / n; res.avgAway = res.ag / n;
    res.avgMargin = res.avgHome - res.avgAway; res.avgTotal = res.avgHome + res.avgAway;
    res.otPct = (res.otHome + res.otAway + res.soHome + res.soAway) / n;
    res.homeScoreProb = Array.from(res.homeScored, v => v / n);
    res.awayScoreProb = Array.from(res.awayScored, v => v / n);
    res.goalies = { home: H.goalie.name, away: A.goalie.name };
    res.factors = M.factors;
    return res;
  }


  // ---------- Replay: the simulated game closest to the average result ----------
  // Re-simulates up to `tries` games with event logging and keeps the one whose final score is closest to the
  // average score of the main run (and where the more likely winner wins). Returns {events, final, ...}.
  function replayNBA(home, away, opts, avg) {
    const rng = mulberry32((opts.seed || 12345) + 777);
    const hca = opts.hca == null ? 1.5 : opts.hca, noise = opts.noise == null ? 2.5 : opts.noise, lg = opts.leagueOrtg || 114;
    const repl = opts.replFactor == null ? 0.88 : opts.replFactor;
    const M = nbaMods(home, away, opts);
    const H = prepNbaSide(M.homeT, opts.outHome || new Set(), repl), A = prepNbaSide(M.awayT, opts.outAway || new Set(), repl);
    const pace = (home.pace + away.pace) / 2, homeFav = avg.h >= avg.a;
    let best = null;
    for (let t = 0; t < (opts.tries || 3000); t++) {
      const oH = (home.ortg + away.drtg - lg) + hca * 0.5 + M.addH + noise * randn(rng) + 100 * (H.injuryFactor - 1);
      const oA = (away.ortg + home.drtg - lg) - hca * 0.5 + M.addA + noise * randn(rng) + 100 * (A.injuryFactor - 1);
      const poss = Math.round(pace + randn(rng) * 2.5);
      const ev = []; let sh = 0, sa = 0;
      const dummy = new Float64Array(20);
      for (let k = 0; k < poss; k++) {
        const th = (k + rng() * 0.9) / poss * 2880, ta = (k + rng() * 0.9) / poss * 2880;
        const x = nbaPossession(H, oH, rng, dummy); if (x) ev.push({ t: th, side: 'h', player: H.players[H.last].name, pts: x });
        const y = nbaPossession(A, oA, rng, dummy); if (y) ev.push({ t: ta, side: 'a', player: A.players[A.last].name, pts: y });
        sh += x; sa += y;
      }
      let ot = 0, endT = 2880;
      while (sh === sa && ot < 6) {
        const otPoss = Math.max(8, Math.round(poss * 5 / 48));
        for (let k = 0; k < otPoss; k++) {
          const tt = 2880 + ot * 300 + (k + rng() * 0.9) / otPoss * 300;
          const x = nbaPossession(H, oH, rng, dummy); if (x) { ev.push({ t: tt, side: 'h', player: H.players[H.last].name, pts: x }); sh += x; }
          const y = nbaPossession(A, oA, rng, dummy); if (y) { ev.push({ t: tt + 1, side: 'a', player: A.players[A.last].name, pts: y }); sa += y; }
        }
        ot++; endT = 2880 + ot * 300;
      }
      if (sh === sa) continue;
      if ((sh > sa) !== homeFav) continue;
      const dist = Math.abs(sh - avg.h) + Math.abs(sa - avg.a) + ot * 6;
      if (!best || dist < best.dist) {
        ev.sort((a, b) => a.t - b.t);
        best = { dist, events: ev, final: { h: sh, a: sa }, ot, endT };
        if (dist < 2) break;
      }
    }
    return best;
  }

  function replayNHL(home, away, opts, avg) {
    const rng = mulberry32((opts.seed || 12345) + 999);
    const hca = opts.hca == null ? 0.03 : opts.hca, lg = opts.league || { sfg: 30, sv: 0.905 };
    const M = nhlMods(home, away, opts);
    const H = prepNhlSide(home, opts.outHome || new Set(), opts.goalieHome), A = prepNhlSide(away, opts.outAway || new Set(), opts.goalieAway);
    const sfH0 = (home.sfg + away.sag) / 2, sfA0 = (away.sfg + home.sag) / 2, lgFail = 1 - lg.sv, homeFav = avg.h >= avg.a;
    let best = null;
    function game(side, opp, rate, tag, ev, shotsCount) {
      const shots = poisson(rate, rng); let goals = 0;
      const ff = (1 - opp.goalie.sv) / lgFail;
      for (let s = 0; s < shots; s++) {
        const t = rng() * 3600, i = pick(side.cum, rng), p = side.players[i];
        shotsCount[tag === 'h' ? 0 : 1]++;
        ev.push({ t, side: tag, shot: true });
        if (rng() < clamp(p.shPct * ff, 0.01, 0.4)) { goals++; ev.push({ t: t + 0.5, side: tag, player: p.name, goal: true }); }
      }
      return goals;
    }
    for (let t = 0; t < (opts.tries || 3000); t++) {
      const nH = Math.exp(0.12 * randn(rng)), nA = Math.exp(0.12 * randn(rng));
      const rH = sfH0 * H.shotScale * (1 + hca) * nH * M.mH, rA = sfA0 * A.shotScale * (1 - hca) * nA * M.mA;
      const ev = [], sc = [0, 0];
      let gh = game(H, A, rH, 'h', ev, sc), ga = game(A, H, rA, 'a', ev, sc), kind = 'reg', endT = 3600;
      if (gh === ga) {
        const lamH = (rH / 60) * 0.12 * 1.8 * 0.95, lamA = (rA / 60) * 0.12 * 1.8 * 0.95;
        const tH = -Math.log(1 - rng()) / Math.max(lamH, 1e-6), tA = -Math.log(1 - rng()) / Math.max(lamA, 1e-6);
        if (Math.min(tH, tA) <= 5) {
          kind = 'ot'; const tt = 3600 + Math.min(tH, tA) * 60; endT = tt;
          if (tH < tA) { gh++; ev.push({ t: tt, side: 'h', player: H.players[pick(H.cum, rng)].name, goal: true, ot: true }); }
          else { ga++; ev.push({ t: tt, side: 'a', player: A.players[pick(A.cum, rng)].name, goal: true, ot: true }); }
        } else {
          kind = 'so'; endT = 3600 + 300;
          if (rng() < 0.5) { gh++; ev.push({ t: endT, side: 'h', so: true }); } else { ga++; ev.push({ t: endT, side: 'a', so: true }); }
        }
      }
      if ((gh > ga) !== homeFav) continue;
      const dist = Math.abs(gh - avg.h) + Math.abs(ga - avg.a) + (kind === 'reg' ? 0 : 1.5);
      if (!best || dist < best.dist) {
        ev.sort((a, b) => a.t - b.t);
        best = { dist, events: ev, final: { h: gh, a: ga }, kind, endT, shots: { h: sc[0], a: sc[1] }, goalies: { home: H.goalie.name, away: A.goalie.name } };
        if (dist < 0.5) break;
      }
    }
    return best;
  }

  // Helper: histogram of integer values
  function histogram(arr, lo, hi) {
    const bins = new Array(hi - lo + 1).fill(0);
    for (const v of arr) { const c = clamp(v, lo, hi); bins[c - lo]++; }
    return bins;
  }

  const api = { simulateNBA, simulateNHL, replayNBA, replayNHL, histogram, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
