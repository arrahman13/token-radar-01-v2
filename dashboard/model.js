// Token Radar model: fitted launch-value and launch-odds models over the
// sealed DefiLlama snapshot, farm economics, and board construction.
// Plain JS, standard library only, fully deterministic: no randomness,
// no wall clock (the snapshot's as_of is the only date), fixed-iteration
// optimisers, explicit slug tie-breaks on every sort.
// The same file runs in Node (main.ts) and in the browser (dashboard),
// so the page recomputes the board the program wrote, bit for bit.

const FLOOR_USD = 50000000;

const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const BRIDGE_CATS = ['Bridge', 'Canonical Bridge'];
const STAKING_CATS = ['Liquid Staking', 'Liquid Restaking', 'Restaked BTC'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

// Coarse category groups: fine enough to carry a pricing effect, coarse
// enough that each group holds peers to fit on.
function groupOf(category) {
  switch (category) {
    case 'Dexs': return 'Dexs';
    case 'Lending': return 'Lending';
    case 'Derivatives': return 'Derivatives';
    case 'Yield': case 'Yield Aggregator': case 'Leveraged Farming':
    case 'Basis Trading': case 'Liquidity Manager': return 'Yield';
    case 'RWA': return 'RWA';
    case 'Chain': return 'Chain';
    case 'CEX': return 'CEX';
    case 'CDP': return 'CDP';
    case 'Liquid Staking': case 'Liquid Restaking': case 'Restaked BTC':
    case 'Staking Pool': return 'Staking';
    case 'Bridge': case 'Canonical Bridge': case 'Cross Chain Bridge': return 'Bridge';
    default: return 'Other';
  }
}

function recordsToken(p) { return p.gecko_id != null || p.symbol != null; }

// Why a tokenless protocol is not on the board, or null when it is a
// candidate. Mirrors the watchlist's own screens, in its order.
function exclusionReason(p) {
  const cat = p.category || '';
  if (BRIDGE_CATS.includes(cat)) return 'bridge';
  if (STAKING_CATS.includes(cat)) return 'staking';
  if (cat === 'CEX') return 'cex';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped';
  if (EXCHANGE_PREFIX.some((e) => p.name.startsWith(e))) return 'exchange';
  return null;
}

const EXCLUSION_LABEL = {
  bridge: 'Bridge products',
  staking: 'Liquid staking / restaking',
  cex: 'Exchange (CEX) products',
  versioned: 'Versioned successors',
  wrapped: 'Wrapped / staked by name',
  exchange: 'Exchange-branded products',
};

// Split the snapshot's 758 protocols into the ranked candidates, the ones
// that already record a token, and the excluded groups. Counts sum to 758.
function classify(snapshot) {
  const watch = new Set(snapshot.watchlist);
  const ranked = [], token = [], excluded = {};
  for (const p of snapshot.protocols) {
    if (recordsToken(p)) { token.push(p); continue; }
    const why = exclusionReason(p);
    if (why) { (excluded[why] = excluded[why] || []).push(p); continue; }
    ranked.push({ p, tier: watch.has(p.slug) ? 'watchlist' : 'early' });
  }
  ranked.sort((a, b) => (a.p.slug < b.p.slug ? -1 : 1));
  return { ranked, token, excluded };
}

// ---- small deterministic numerics ---------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const i = q * (sorted.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function median(xs) { return quantile([...xs].sort((a, b) => a - b), 0.5); }
function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

function ageYears(p, asOfMs) {
  if (!p.listed_at) return null;
  const t = Date.parse(p.listed_at + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.max(0, (asOfMs - t) / (365.25 * 86400000));
}

// Solve (A) x = b by Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// Invert a small symmetric matrix by Gauss-Jordan.
function invertMatrix(A) {
  const n = A.length, M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

// ---- the launch-value model ---------------------------------------------
// Peers: protocols that record a token with a market cap. The response is
// log(mcap / TVL): what a dollar of TVL is worth once a token trades.
// Candidate terms are admitted one at a time, greedily, and only when they
// lower BOTH held-out misses: leave-one-out (exact, via the hat matrix)
// and walk-forward (fit on earlier-listed peers, tested on later ones).
// Terms that fail are kept in the table as tested-and-rejected.

const VALUE_TERMS = [
  { id: 'size', label: 'Size curve: log TVL', base: true },
  { id: 'growth', label: 'Momentum: 7d TVL change' },
  { id: 'age', label: 'Seasoning: log age with no token' },
  { id: 'groups', label: 'Category effects (ridge-shrunk)' },
];

function peerFeatures(p, asOfMs, medianAge) {
  const age = ageYears(p, asOfMs);
  return {
    logTvl: Math.log(Math.max(1, p.tvl_usd)),
    growth: clamp(p.change_7d == null ? 0 : p.change_7d, -50, 100) / 25,
    logAge: Math.log(1 + (age == null ? medianAge : age)),
    group: groupOf(p.category),
  };
}

function designMatrix(peers, feats, termIds, groups) {
  return peers.map((p, i) => {
    const f = feats[i], row = [1];
    for (const t of termIds) {
      if (t === 'size') row.push(f.logTvl);
      else if (t === 'growth') row.push(f.growth);
      else if (t === 'age') row.push(f.logAge);
      else if (t === 'groups') for (const g of groups) row.push(f.group === g ? 1 : 0);
    }
    return row;
  });
}

function penalties(termIds, groups) {
  const pen = [0];
  for (const t of termIds) {
    if (t === 'size') pen.push(0.5);
    else if (t === 'growth') pen.push(1.0);
    else if (t === 'age') pen.push(1.0);
    else if (t === 'groups') for (const _ of groups) pen.push(6.0);
  }
  return pen;
}

function ridgeFit(X, y, pen) {
  const k = X[0].length, XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < k; a++) XtX[a][a] += pen[a];
  const beta = solveLinear(XtX, Xty);
  const inv = invertMatrix(XtX);
  return { beta, inv };
}

function evalModel(peers, feats, y, termIds, groups) {
  const X = designMatrix(peers, feats, termIds, groups), pen = penalties(termIds, groups);
  const { beta, inv } = ridgeFit(X, y, pen);
  const resid = X.map((row, i) => y[i] - row.reduce((s, v, j) => s + v * beta[j], 0));
  // Exact leave-one-out residuals for ridge: e_i / (1 - h_i).
  let looAbs = 0;
  for (let i = 0; i < X.length; i++) {
    let h = 0;
    for (let a = 0; a < X[i].length; a++) for (let b = 0; b < X[i].length; b++) h += X[i][a] * inv[a][b] * X[i][b];
    looAbs += Math.abs(resid[i] / Math.max(1e-9, 1 - h));
  }
  const looMiss = Math.exp(looAbs / X.length);
  // Walk-forward: two expanding-window folds over listing date.
  const dated = peers.map((p, i) => i).filter((i) => peers[i].listed_at)
    .sort((a, b) => (peers[a].listed_at < peers[b].listed_at ? -1 : peers[a].listed_at > peers[b].listed_at ? 1 : peers[a].slug < peers[b].slug ? -1 : 1));
  let wfAbs = 0, wfN = 0;
  for (const cut of [0.5, 0.75]) {
    const split = Math.floor(dated.length * cut), train = dated.slice(0, split), test = dated.slice(split, cut === 0.5 ? Math.floor(dated.length * 0.75) : dated.length);
    if (train.length < 10 || test.length === 0) continue;
    const Xtr = train.map((i) => X[i]), ytr = train.map((i) => y[i]);
    const { beta: b2 } = ridgeFit(Xtr, ytr, pen);
    for (const i of test) { wfAbs += Math.abs(y[i] - X[i].reduce((s, v, j) => s + v * b2[j], 0)); wfN++; }
  }
  const wfMiss = wfN ? Math.exp(wfAbs / wfN) : Infinity;
  return { beta, looMiss, wfMiss, resid, X };
}

function fitValueModel(snapshot) {
  const asOfMs = Date.parse(snapshot.as_of + 'T00:00:00Z');
  const peers = snapshot.protocols.filter((p) => recordsToken(p) && p.mcap_usd != null && p.mcap_usd >= 5000000 && p.tvl_usd >= 1000000)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const ages = peers.map((p) => ageYears(p, asOfMs)).filter((a) => a != null);
  const medianAge = median(ages);
  const feats = peers.map((p) => peerFeatures(p, asOfMs, medianAge));
  const y = peers.map((p) => Math.log(p.mcap_usd / p.tvl_usd));
  const groupCounts = {};
  for (const f of feats) groupCounts[f.group] = (groupCounts[f.group] || 0) + 1;
  const groups = Object.keys(groupCounts).filter((g) => groupCounts[g] >= 6).sort();

  const medMult = median(peers.map((p) => p.mcap_usd / p.tvl_usd));
  const baseMiss = Math.exp(mean(y.map((v) => Math.abs(v - Math.log(medMult)))));

  let current = ['size'];
  let cur = evalModel(peers, feats, y, current, groups);
  const table = [{ id: 'flat', label: 'Flat baseline: median multiple for all', loo: baseMiss, wf: baseMiss, kept: false, note: 'reference' },
                 { id: 'size', label: VALUE_TERMS[0].label, loo: cur.looMiss, wf: cur.wfMiss, kept: true, note: 'base term' }];
  const remaining = VALUE_TERMS.filter((t) => !t.base).map((t) => t.id);
  const rejected = [];
  for (;;) {
    let best = null;
    for (const id of remaining) {
      const trial = evalModel(peers, feats, y, [...current, id], groups);
      if (trial.looMiss < cur.looMiss && trial.wfMiss < cur.wfMiss) {
        const gain = (cur.looMiss - trial.looMiss) + (cur.wfMiss - trial.wfMiss);
        if (!best || gain > best.gain) best = { id, trial, gain };
      }
    }
    if (!best) break;
    current.push(best.id); cur = best.trial;
    remaining.splice(remaining.indexOf(best.id), 1);
    table.push({ id: best.id, label: VALUE_TERMS.find((t) => t.id === best.id).label, loo: cur.looMiss, wf: cur.wfMiss, kept: true, note: 'lowers both held-out misses' });
  }
  for (const id of remaining) {
    const trial = evalModel(peers, feats, y, [...current, id], groups);
    rejected.push({ id, label: VALUE_TERMS.find((t) => t.id === id).label, loo: trial.looMiss, wf: trial.wfMiss, kept: false, note: 'tested on the final model: fails one or both held-out tests' });
  }
  // LOO residuals of the final model give the printed ranges and honesty.
  const X = cur.X, pen = penalties(current, groups), { inv } = ridgeFit(X, y, pen);
  const looResid = cur.resid.map((e, i) => {
    let h = 0;
    for (let a = 0; a < X[i].length; a++) for (let b = 0; b < X[i].length; b++) h += X[i][a] * inv[a][b] * X[i][b];
    return e / Math.max(1e-9, 1 - h);
  }).sort((a, b) => a - b);
  const qs = { q10: quantile(looResid, 0.10), q25: quantile(looResid, 0.25), q75: quantile(looResid, 0.75), q90: quantile(looResid, 0.90) };
  let in2575 = 0, in1090 = 0;
  for (const e of looResid) { if (e >= qs.q25 && e <= qs.q75) in2575++; if (e >= qs.q10 && e <= qs.q90) in1090++; }
  const beta = cur.beta, termIds = [...current];
  function predictMultiple(p) {
    const f = peerFeatures(p, asOfMs, medianAge);
    const row = [1];
    for (const t of termIds) {
      if (t === 'size') row.push(f.logTvl);
      else if (t === 'growth') row.push(f.growth);
      else if (t === 'age') row.push(f.logAge);
      else if (t === 'groups') for (const g of groups) row.push(f.group === g ? 1 : 0);
    }
    return Math.exp(row.reduce((s, v, j) => s + v * beta[j], 0));
  }
  return {
    peers: peers.length, medianAge, terms: [...table, ...rejected], keptTerms: termIds,
    looMiss: cur.looMiss, wfMiss: cur.wfMiss, baseMiss, quantiles: qs,
    coverage2575: in2575 / looResid.length, coverage1090: in1090 / looResid.length,
    predictMultiple,
  };
}

// ---- the launch-odds model ----------------------------------------------
// Logistic regression on the plausible-launch universe (every protocol
// that passes the board's screens, token-recorded or not): the target is
// "records a token". Features: log TVL, age, 7d growth, chain count.
// Fixed-iteration gradient descent, zero init: the same fit every run.
// Scored by Brier against the base-rate forecaster, and by age band.

function fitOddsModel(snapshot) {
  const asOfMs = Date.parse(snapshot.as_of + 'T00:00:00Z');
  const universe = snapshot.protocols.filter((p) => !exclusionReason(p) || recordsToken(p))
    .filter((p) => recordsToken(p) || !exclusionReason(p))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const ages = universe.map((p) => ageYears(p, asOfMs)).filter((a) => a != null);
  const medianAge = median(ages);
  const raw = universe.map((p) => {
    const age = ageYears(p, asOfMs);
    return [Math.log(Math.max(1, p.tvl_usd)) / 10, (age == null ? medianAge : age) / 5,
            clamp(p.change_7d == null ? 0 : p.change_7d, -50, 100) / 25, Math.log(1 + p.chains.length)];
  });
  const mu = [0, 1, 2, 3].map((j) => mean(raw.map((r) => r[j])));
  const sd = [0, 1, 2, 3].map((j) => Math.sqrt(mean(raw.map((r) => (r[j] - mu[j]) ** 2))) || 1);
  const X = raw.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const yv = universe.map((p) => (recordsToken(p) ? 1 : 0));
  const baseRate = mean(yv);
  let w = [0, 0, 0, 0], b = Math.log(baseRate / (1 - baseRate));
  const LR = 0.05, L2 = 0.001, ITER = 4000;
  for (let it = 0; it < ITER; it++) {
    const gw = [0, 0, 0, 0]; let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const z = b + X[i].reduce((s, v, j) => s + v * w[j], 0);
      const pr = 1 / (1 + Math.exp(-clamp(z, -30, 30))), d = pr - yv[i];
      gb += d; for (let j = 0; j < 4; j++) gw[j] += d * X[i][j];
    }
    b -= LR * gb / X.length;
    for (let j = 0; j < 4; j++) w[j] -= LR * (gw[j] / X.length + L2 * w[j]);
  }
  function predict(p) {
    const age = ageYears(p, asOfMs);
    const r = [Math.log(Math.max(1, p.tvl_usd)) / 10, (age == null ? medianAge : age) / 5,
               clamp(p.change_7d == null ? 0 : p.change_7d, -50, 100) / 25, Math.log(1 + p.chains.length)];
    const z = b + r.reduce((s, v, j) => s + ((v - mu[j]) / sd[j]) * w[j], 0);
    return clamp(1 / (1 + Math.exp(-clamp(z, -30, 30))), 0.005, 0.97);
  }
  let brier = 0, brierBase = 0;
  for (let i = 0; i < universe.length; i++) {
    brier += (predict(universe[i]) - yv[i]) ** 2;
    brierBase += (baseRate - yv[i]) ** 2;
  }
  brier /= universe.length; brierBase /= universe.length;
  // Calibration by age band: realised token rate vs mean prediction.
  const bands = [[0, 1], [1, 2], [2, 4], [4, 99]].map(([lo, hi]) => {
    const rows = universe.filter((p) => { const a = ageYears(p, asOfMs); return a != null && a >= lo && a < hi; });
    if (!rows.length) return { label: lo + '-' + (hi === 99 ? '+' : hi) + 'y', n: 0, realised: 0, predicted: 0 };
    return { label: lo + '-' + (hi === 99 ? '+' : hi) + 'y', n: rows.length,
             realised: mean(rows.map((p) => (recordsToken(p) ? 1 : 0))), predicted: mean(rows.map((p) => predict(p))) };
  });
  return { n: universe.length, baseRate, brier, brierBase, bands, predict };
}

// ---- the "when" estimate --------------------------------------------------
// Peers that record a token give a distribution of ages at which a token
// is on record. For a protocol already aged a with no token recorded, the
// estimate is the conditional median of that distribution above a, less a.
// It is the peers' median, stated as such, never a prediction.

function buildWhenIndex(snapshot) {
  const asOfMs = Date.parse(snapshot.as_of + 'T00:00:00Z');
  const byGroup = {}, all = [];
  for (const p of snapshot.protocols) {
    if (!recordsToken(p)) continue;
    const a = ageYears(p, asOfMs);
    if (a == null) continue;
    all.push(a); (byGroup[groupOf(p.category)] = byGroup[groupOf(p.category)] || []).push(a);
  }
  all.sort((x, y) => x - y);
  for (const g of Object.keys(byGroup)) byGroup[g].sort((x, y) => x - y);
  return function whenMonths(p) {
    const a = ageYears(p, asOfMs) || 0;
    let pool = (byGroup[groupOf(p.category)] || []).filter((x) => x > a);
    if (pool.length < 5) pool = all.filter((x) => x > a);
    if (!pool.length) return 6;
    return Math.max(1, Math.round((median(pool) - a) * 12));
  };
}

// ---- farm economics -------------------------------------------------------
// One stated scenario, printed on the page: a plan of planUsd, farmers in
// aggregate receive dropShare of the launch value, competing farm capital
// is farmCapitalShare of TVL, fees are bridge + chain gas + swap drag +
// weekly upkeep, and the plan's hours come from its own steps.

const SCENARIO = { planUsd: 5000, dropShare: 0.05, farmCapitalShare: 0.10, farmBar: 50, marginalBar: 15 };

const CHAIN_GAS = { Ethereum: 42, Solana: 2, Base: 3, Arbitrum: 3, Optimism: 3, Polygon: 2, Avalanche: 4, 'BNB Chain': 6 };
function chainGas(chain) { return CHAIN_GAS[chain] != null ? CHAIN_GAS[chain] : 8; }

const CORE_ACTION = {
  Dexs: 'Route swaps through the pool: trade the plan in $250 clips across the two deepest pairs so volume, fees paid and points accrue on this wallet.',
  Lending: 'Supply the plan as collateral on the main market, then borrow at most 40% against it and re-supply once: the loop is what the points snapshot weighs.',
  Derivatives: 'Open small hedged perpetual positions (long and short legs matched) and keep them open across funding snapshots; size so margin stays under 30% of the plan.',
  Yield: 'Deposit the plan into the flagship vault and hold the receipt token in the same wallet; auto-compound weekly so the balance the snapshot reads keeps growing.',
  CDP: 'Mint the stablecoin against the plan as collateral at a conservative 180% ratio and park the minted coins in the protocol’s own stability pool.',
  RWA: 'Subscribe the plan to the shortest-tenor real-world-asset vault and hold the position token; register for the holder mailing list if one is offered.',
  Chain: 'Hold a working balance on the chain itself, pay gas with it daily and run one contract interaction a day so the wallet reads as native, not bridged-in.',
  Other: 'Take the protocol’s core position with the plan (deposit, stake or subscribe as its interface offers) and hold it in one wallet so the activity is attributable.',
};

function farmSteps(p, planUsd, weeks) {
  const g = groupOf(p.category), chain = p.chains[0] || 'Ethereum';
  const share = (100 * planUsd / Math.max(1, p.tvl_usd)).toFixed(3);
  const steps = [];
  if (p.chains.length > 1 || chain !== 'Ethereum')
    steps.push('Bridge $' + Math.round(planUsd * 0.98) + ' to ' + chain + ' (the chain holding most of ' + p.name + '’s TVL) through its canonical bridge; budget $12 in bridge and gas fees and 25 minutes, and keep the arrival transaction hash.');
  else
    steps.push('Fund a fresh wallet with $' + planUsd + ' on ' + chain + '; budget $' + chainGas(chain) + ' in gas for setup and 20 minutes, and keep this wallet dedicated to ' + p.name + ' so its activity is attributable.');
  steps.push('Acquire the position asset in two clips of $' + Math.round(planUsd / 2) + ' an hour apart; budget 0.35% swap drag (about $' + Math.round(planUsd * 0.0035) + ') and 30 minutes, and avoid the hour around any announced snapshot.');
  steps.push(CORE_ACTION[g] || CORE_ACTION.Other);
  steps.push('Split the position: keep 80% in the core action and put 20% into the protocol’s second product (another market, pool or vault it runs) so the wallet shows breadth, not a single deposit.');
  steps.push('Run a weekly cadence for ' + weeks + ' weeks: one interaction, one claim or rebalance every week at about $1.20 in gas and 20 minutes each, so the wallet never reads as dormant before a snapshot.');
  steps.push('Track ' + p.name + '’s governance forum and announcements monthly; if a token vote or points programme appears, register this same wallet first — the plan is ' + share + '% of TVL, sized to be visible without dominating the pool.');
  steps.push('Exit discipline: if no token is recorded within the horizon, unwind in two clips a week apart (about $' + Math.round(planUsd * 0.003) + ' in drag) rather than panic-selling the position on a rumour.');
  return steps;
}

function farmEconomics(p, launchValue, odds, months, planUsd) {
  const plan = planUsd == null ? SCENARIO.planUsd : planUsd;
  const weeks = clamp(Math.round(months * 4.33), 4, 52);
  const steps = farmSteps(p, plan, weeks);
  const capture = plan / (plan + SCENARIO.farmCapitalShare * Math.max(1, p.tvl_usd));
  const grossIf = launchValue * SCENARIO.dropShare * capture;
  const expected = odds * grossIf;
  const routed = (p.chains.length > 1 || (p.chains[0] || 'Ethereum') !== 'Ethereum') ? 12 : 0;
  const fees = routed + chainGas(p.chains[0] || 'Ethereum') + plan * 0.0035 + 1.2 * weeks + plan * 0.003;
  const hours = 0.7 + 0.5 + 0.8 + 0.4 + weeks * (20 / 60) + months * 0.5 + 0.3 + 0.4;
  const net = expected - fees, perHour = net / hours;
  const verdict = perHour >= SCENARIO.farmBar ? 'FARM' : perHour >= SCENARIO.marginalBar ? 'MARGINAL' : 'SKIP';
  return { plan, weeks, steps, capture, grossIf, expected, fees, hours, net, perHour, verdict };
}

// ---- the board --------------------------------------------------------------

function buildBoard(snapshot) {
  const asOfMs = Date.parse(snapshot.as_of + 'T00:00:00Z');
  const { ranked, token, excluded } = classify(snapshot);
  const value = fitValueModel(snapshot), odds = fitOddsModel(snapshot), whenMonths = buildWhenIndex(snapshot);
  const q = value.quantiles;
  const rows = ranked.map(({ p, tier }) => {
    const multiple = value.predictMultiple(p);
    const launchValue = p.tvl_usd * multiple;
    const o = odds.predict(p);
    const months = whenMonths(p);
    const econ = farmEconomics(p, launchValue, o, months, SCENARIO.planUsd);
    const age = ageYears(p, asOfMs);
    return {
      slug: p.slug, name: p.name, tier, category: p.category, group: groupOf(p.category), chains: p.chains,
      tvl: p.tvl_usd, change7d: p.change_7d, ageYears: age, multiple, launchValue,
      odds: o, months, implied: launchValue * o,
      p25: launchValue * Math.exp(q.q25) * o, p75: launchValue * Math.exp(q.q75) * o,
      econ: { fees: econ.fees, hours: econ.hours, weeks: econ.weeks, expected: econ.expected, net: econ.net, perHour: econ.perHour, verdict: econ.verdict, steps: econ.steps },
    };
  });
  rows.sort((a, b) => (b.implied - a.implied) || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const accounting = {
    total: snapshot.protocols.length, ranked: rows.length, tokenRecorded: token.length,
    excluded: Object.fromEntries(Object.entries(excluded).map(([k, v]) => [k, v.length])),
    watchlist: rows.filter((r) => r.tier === 'watchlist').length,
  };
  return { rows, accounting, value, odds, asOf: snapshot.as_of };
}

// FNV-1a over the board's canonical row string: the page recomputes the
// same rows from the embedded snapshot and checks this checksum.
function boardChecksum(rows) {
  let h = 0x811c9dc5;
  const s = rows.map((r) => r.slug + ':' + r.rank + ':' + Math.round(r.implied)).join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

// One namespace for both runtimes: Node reads module.exports, the
// browser reads window.RadarModel. Same functions, same numbers.
const RadarModel = { FLOOR_USD, groupOf, recordsToken, exclusionReason, EXCLUSION_LABEL, classify,
  quantile, median, mean, clamp, ageYears, solveLinear, invertMatrix, fitValueModel, fitOddsModel,
  buildWhenIndex, SCENARIO, chainGas, farmSteps, farmEconomics, buildBoard, boardChecksum };
if (typeof window !== 'undefined') window.RadarModel = RadarModel;
if (typeof module !== 'undefined' && module.exports) module.exports = RadarModel;
