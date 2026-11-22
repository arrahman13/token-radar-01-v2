// Token Radar page: recomputes the whole board from the embedded sealed
// snapshot with the same model the program ran (model.js), then renders
// it. If the recompute disagrees with board.json's integrity values, the
// header says so instead of hiding it.
(function () {
  'use strict';
  var M = window.RadarModel, D = window.RADAR_DATA;
  var snap = D.snapshot, board = M.buildBoard(snap), rows = board.rows;
  var bySlug = {}; snap.protocols.forEach(function (p) { bySlug[p.slug] = p; });
  var plan = 5000, tab = 'all', sortK = 'rank', sortDir = 1, selSlug = null;

  function $(id) { return document.getElementById(id); }
  function fmt$(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
    return '$' + Math.round(v);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function econ(r) { return M.farmEconomics(bySlug[r.slug], r.launchValue, r.odds, r.months, plan); }

  // ---- integrity -------------------------------------------------------
  var ck = M.boardChecksum(rows);
  var ok = ck === D.integrity.checksum && rows.length === D.integrity.rows &&
    board.accounting.watchlist === D.integrity.watchlist && board.accounting.total === D.integrity.accounted;
  $('topintegrity').innerHTML = ok
    ? 'integrity ✓ recomputed board matches board.json<br>checksum ' + ck + ' · ' + rows.length + ' rows'
    : 'integrity ✗ MISMATCH vs board.json';
  $('topintegrity').className = 'topright' + (ok ? '' : ' bad');
  $('asof').textContent = snap.as_of;
  $('accttotal').textContent = board.accounting.total;
  $('integrity').innerHTML = 'Integrity: this page recomputed <b>' + rows.length + ' rows</b> from the embedded snapshot · checksum <b>' +
    ck + '</b> (board.json: ' + D.integrity.checksum + ') · watchlist covered <b>' + board.accounting.watchlist + '/40</b> · ledger <b>' +
    board.accounting.total + '/' + D.integrity.accounted + '</b> protocols accounted · total implied value <b>' +
    fmt$(rows.reduce(function (s, r) { return s + r.implied; }, 0)) + '</b>. Implied value is this radar\u2019s own claim, fitted and cross-checked above — not a promise that any token launches.';

  // ---- stat cards --------------------------------------------------------
  var v = board.value, o = board.odds;
  var farmCount = rows.filter(function (r) { return econ(r).verdict === 'FARM'; }).length;
  var cards = [
    ['×' + v.looMiss.toFixed(2), 'Value miss, leave-one-out', 'flat baseline ×' + v.baseMiss.toFixed(2)],
    ['×' + v.wfMiss.toFixed(2), 'Value miss, walk-forward', 'fit early, tested late'],
    [Math.round(v.coverage2575 * 100) + '% <em>in band</em>', 'Range honesty P25–P75', 'stated coverage 50%'],
    [o.brier.toFixed(3) + ' <em>brier</em>', 'Odds model vs base ' + o.brierBase.toFixed(3), 'lower is better'],
    [String(farmCount), 'Worth farming at $5k plan', 'verdict FARM, of ' + rows.length],
    [board.accounting.watchlist + '/40', 'Watchlist covered', 'plus ' + (rows.length - board.accounting.watchlist) + ' early finds'],
  ];
  $('stats').innerHTML = cards.map(function (c) {
    return '<div class="stat"><div class="v">' + c[0] + '</div><div class="k">' + c[1] + '</div><div class="s">' + c[2] + '</div></div>';
  }).join('');

  // ---- accounting bar ----------------------------------------------------
  var seg = [['Ranked on this board', board.accounting.ranked, '#f5a524'], ['Already record a token', board.accounting.tokenRecorded, '#3f6fb5']];
  var exLabel = { bridge: 'Bridge products', staking: 'Liquid staking / restaking', cex: 'Exchange (CEX) products', versioned: 'Versioned successors', wrapped: 'Wrapped / staked by name', exchange: 'Exchange-branded' };
  var exColor = { bridge: '#7a4fd0', staking: '#2aa198', cex: '#b5543f', versioned: '#8a94a6', wrapped: '#5c6678', exchange: '#4a5872' };
  Object.keys(board.accounting.excluded).forEach(function (k) { seg.push([exLabel[k] || k, board.accounting.excluded[k], exColor[k] || '#4a5872']); });
  var tot = board.accounting.total;
  $('acctbar').innerHTML = seg.map(function (s) { return '<div style="width:' + (100 * s[1] / tot) + '%;background:' + s[2] + '"></div>'; }).join('');
  $('acctlegend').innerHTML = seg.map(function (s) { return '<span><i style="background:' + s[2] + '"></i>' + s[0] + ' · ' + s[1] + '</span>'; }).join('');

  // ---- model panels ------------------------------------------------------
  $('modelnote').innerHTML = 'Fitted on <b>' + v.peers + ' peers</b> that record a token with a priced market (mcap ≥ $5M, TVL ≥ $1M). Response: log(market cap ÷ TVL). Flat baseline miss ×' + v.baseMiss.toFixed(2) + '.';
  $('termtable').innerHTML = '<tr><th>Term</th><th>LOO miss</th><th>Walk-fwd</th><th>Fate</th></tr>' + v.terms.map(function (t) {
    return '<tr><td>' + esc(t.label) + '</td><td>' + (t.loo ? '×' + t.loo.toFixed(2) : '—') + '</td><td>' + (t.wf ? '×' + t.wf.toFixed(2) : '—') +
      '</td><td class="' + (t.kept ? 'kept' : 'rej') + '">' + (t.kept ? 'KEPT' : 'rejected') + '</td></tr>';
  }).join('');
  function rbar(lab, actual, want) {
    return '<div class="rbar"><span class="lab">' + lab + '</span><span class="track"><span class="fill" style="width:' + Math.min(100, actual) +
      '%"></span><span class="want" style="left:' + want + '%"></span></span><span class="val">' + actual.toFixed(1) + '% vs ' + want + '% stated</span></div>';
  }
  $('ranges').innerHTML = rbar('P25–P75 band', v.coverage2575 * 100, 50) + rbar('P10–P90 band', v.coverage1090 * 100, 80) +
    '<p class="muted">Bands are the final model\u2019s leave-one-out residual quantiles, printed on every row. The white tick is the coverage the band claims; the bar is what the peers actually did.</p>';
  $('bandtable').innerHTML = '<tr><th>No-token age</th><th>n</th><th>Realised</th><th>Predicted</th></tr>' + o.bands.map(function (b) {
    return '<tr><td>' + b.label + '</td><td>' + b.n + '</td><td>' + Math.round(b.realised * 100) + '%</td><td>' + Math.round(b.predicted * 100) + '%</td></tr>';
  }).join('');
  var S = M.SCENARIO;
  $('scenario').innerHTML = [
    ['Plan size', '$' + S.planUsd.toLocaleString() + ' (change it above)'],
    ['Drop to farmers', (S.dropShare * 100) + '% of launch value'],
    ['Competing farm capital', (S.farmCapitalShare * 100) + '% of TVL'],
    ['Your capture', 'plan ÷ (plan + competing capital)'],
    ['Fees', 'bridge $12 if routed + chain gas + 0.35% swap drag + $1.20/wk upkeep + 0.3% exit drag'],
    ['Verdict FARM', 'expected net ≥ $' + S.farmBar + '/hour of plan work'],
    ['Verdict MARGINAL', 'expected net ≥ $' + S.marginalBar + '/hour'],
    ['When ≈', 'peers\u2019 median months to a recorded token, given this protocol\u2019s age so far'],
  ].map(function (kv) { return '<div class="kv"><span>' + kv[0] + '</span><span>' + kv[1] + '</span></div>'; }).join('');
  function rollup(key) {
    var sums = {};
    rows.forEach(function (r) { var ks = key === 'cat' ? [r.category || '—'] : r.chains; ks.forEach(function (k) { sums[k] = (sums[k] || 0) + r.implied; }); });
    return Object.entries(sums).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
  }
  function rollHtml(title, list) {
    var max = list[0][1];
    return '<p class="muted" style="margin-top:6px">' + title + '</p>' + list.map(function (e) {
      return '<div class="rrow"><span class="rname">' + esc(e[0]) + '</span><span class="rtrack"><span class="rfill" style="width:' + (100 * e[1] / max) + '%"></span></span><span class="rval">' + fmt$(e[1]) + '</span></div>';
    }).join('');
  }
  $('rollup').innerHTML = '<div class="roll">' + rollHtml('By category', rollup('cat')) + rollHtml('By chain', rollup('chain')) + '</div>';

  // ---- controls + table --------------------------------------------------
  var cats = [...new Set(rows.map(function (r) { return r.category; }).filter(Boolean))].sort();
  var chains = [...new Set(rows.flatMap(function (r) { return r.chains; }))].sort();
  $('catf').innerHTML += cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  $('chainf').innerHTML += chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  function visible() {
    var q = $('q').value.trim().toLowerCase(), cat = $('catf').value, ch = $('chainf').value;
    var list = rows.filter(function (r) {
      if (tab === 'watchlist' && r.tier !== 'watchlist') return false;
      if (tab === 'early' && r.tier !== 'early') return false;
      if (tab === 'farm' && econ(r).verdict !== 'FARM') return false;
      if (cat && r.category !== cat) return false;
      if (ch && !r.chains.includes(ch)) return false;
      if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
      return true;
    });
    var key = { rank: 'rank', name: 'name', tvl: 'tvl', change7d: 'change7d', ageYears: 'ageYears', odds: 'odds', months: 'months', launchValue: 'launchValue', implied: 'implied', perHour: null, verdict: null }[sortK];
    list.sort(function (a, b) {
      var va, vb;
      if (sortK === 'perHour') { va = econ(a).perHour; vb = econ(b).perHour; }
      else if (sortK === 'verdict') { va = econ(a).verdict; vb = econ(b).verdict; }
      else if (sortK === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      else { va = a[key] == null ? -1e18 : a[key]; vb = b[key] == null ? -1e18 : b[key]; }
      return (va < vb ? -1 : va > vb ? 1 : a.slug < b.slug ? -1 : 1) * sortDir;
    });
    return list;
  }
  function render() {
    var list = visible();
    $('rowcount').textContent = list.length + ' of ' + rows.length + ' protocols';
    $('rows').innerHTML = list.map(function (r) {
      var e = econ(r);
      return '<tr data-slug="' + r.slug + '"' + (r.slug === selSlug ? ' class="sel"' : '') + '><td class="num">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span><span class="badges"><span class="bdg ' + (r.tier === 'watchlist' ? 'wl' : 'el') + '">' + (r.tier === 'watchlist' ? 'Watchlist' : 'Early') +
        '</span></span><div class="sub2">' + esc(r.category || '—') + ' · ' + esc(r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '')) + '</div></td>' +
        '<td class="num">' + fmt$(r.tvl) + '</td>' +
        '<td class="num ' + (r.change7d == null ? '' : r.change7d >= 0 ? 'pos' : 'neg') + '">' + (r.change7d == null ? '—' : (r.change7d >= 0 ? '+' : '') + r.change7d.toFixed(1)) + '</td>' +
        '<td class="num">' + (r.ageYears == null ? '—' : r.ageYears.toFixed(1) + 'y') + '</td>' +
        '<td class="num">' + Math.round(r.odds * 100) + '%</td>' +
        '<td class="num">' + r.months + ' mo</td>' +
        '<td class="num">' + fmt$(r.launchValue) + '</td>' +
        '<td class="num"><b>' + fmt$(r.implied) + '</b><div class="range">' + fmt$(r.p25) + ' – ' + fmt$(r.p75) + '</div></td>' +
        '<td class="num">' + (e.perHour >= 0 ? '$' + e.perHour.toFixed(1) : '−$' + Math.abs(e.perHour).toFixed(1)) + '</td>' +
        '<td class="v-' + e.verdict + '">' + e.verdict + '</td></tr>';
    }).join('');
    [...$('rows').children].forEach(function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
    });
  }
  document.querySelectorAll('#board th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (sortK === k) sortDir *= -1; else { sortK = k; sortDir = k === 'name' || k === 'verdict' ? 1 : -1; if (k === 'rank') sortDir = 1; }
      render();
    });
  });
  $('tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    tab = b.getAttribute('data-tab');
    [...$('tabs').children].forEach(function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  ['q', 'catf', 'chainf'].forEach(function (id) { $(id).addEventListener('input', render); });
  $('plan').addEventListener('change', function () { plan = parseInt($('plan').value, 10); render(); buildBasket(); if (selSlug) showDetail(selSlug); });

  // ---- detail --------------------------------------------------------------
  function peersOf(r) {
    return snap.protocols.filter(function (p) { return M.recordsToken(p) && p.mcap_usd > 0 && M.groupOf(p.category) === r.group; })
      .sort(function (a, b) { return Math.abs(Math.log(a.tvl_usd) - Math.log(r.tvl)) - Math.abs(Math.log(b.tvl_usd) - Math.log(r.tvl)); }).slice(0, 3);
  }
  function showDetail(slug) {
    var r = rows.find(function (x) { return x.slug === slug; }); if (!r) return;
    selSlug = slug;
    var e = econ(r), d = $('detail');
    var cells = [['TVL', fmt$(r.tvl)], ['7d change', r.change7d == null ? '—' : r.change7d.toFixed(1) + '%'],
      ['No-token age', r.ageYears == null ? '—' : r.ageYears.toFixed(1) + ' years'], ['Fitted multiple', '×' + r.multiple.toFixed(2)],
      ['If it launches', fmt$(r.launchValue)], ['Launch odds', Math.round(r.odds * 100) + '%'],
      ['Implied value', fmt$(r.implied)], ['Range P25–P75', fmt$(r.p25) + ' – ' + fmt$(r.p75)],
      ['When ≈', r.months + ' months (peers\u2019 median)'], ['Plan verdict', e.verdict],
      ['Expected net', fmt$(e.net) + ' on $' + plan.toLocaleString()], ['Plan $/hour', '$' + e.perHour.toFixed(1) + ' over ' + e.hours.toFixed(1) + 'h / ' + e.weeks + ' wks']];
    d.innerHTML = '<h2>' + esc(r.name) + ' <span class="bdg ' + (r.tier === 'watchlist' ? 'wl' : 'el') + '">' + r.tier + '</span> <span class="sub2">rank #' + r.rank + ' · ' +
      esc(r.category || '—') + ' · ' + esc(r.chains.join(', ')) + ' · ' + r.slug + '</span></h2>' +
      '<p class="muted">' + esc(r.name) + ' records no token in the sealed snapshot. Its implied value is TVL × the fitted multiple for its size and category, discounted by the fitted odds that a look-alike protocol records a token.</p>' +
      '<div class="dgrid">' + cells.map(function (c) { return '<div class="dcell"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>'; }).join('') + '</div>' +
      '<div class="cols"><div><h2>Farm plan — $' + plan.toLocaleString() + ', costed step by step</h2><ol class="steps">' +
      e.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="muted">Fees in this plan total ' + fmt$(e.fees) + '; expected gross if a token launches ' + fmt$(e.grossIf) + ', odds-weighted ' + fmt$(e.expected) + '.</p></div>' +
      '<div><h2>Nearest priced peers (' + esc(r.group) + ')</h2>' + peersOf(r).map(function (p) {
        return '<div class="kv"><span>' + esc(p.name) + '</span><span>TVL ' + fmt$(p.tvl_usd) + ' · mcap ' + fmt$(p.mcap_usd) + ' · ×' + (p.mcap_usd / p.tvl_usd).toFixed(2) + '</span></div>';
      }).join('') + '<p class="muted">Real market caps of the closest token-recorded protocols in the same group — the evidence the multiple was fitted on.</p></div></div>';
    d.hidden = false;
    render();
  }
  $('detail').addEventListener('click', function (ev) { if (ev.target === $('detail')) { $('detail').hidden = true; selSlug = null; render(); } });

  // ---- export ---------------------------------------------------------------
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  $('csv').addEventListener('click', function () {
    var lines = ['rank,slug,name,tier,category,tvl_usd,odds_pct,launch_value_usd,implied_value_usd,verdict,usd_per_hour'];
    visible().forEach(function (r) { var e = econ(r); lines.push([r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.tier, r.category || '', r.tvl, Math.round(r.odds * 100), Math.round(r.launchValue), Math.round(r.implied), e.verdict, e.perHour.toFixed(2)].join(',')); });
    download('token-radar-board.csv', lines.join('\n'), 'text/csv');
  });
  $('json').addEventListener('click', function () {
    download('board.json', JSON.stringify({ rows: rows.map(function (r) { return { slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: Math.round(r.implied), farm_steps: r.econ.steps }; }) }, null, 1), 'application/json');
  });

  // ---- basket builder -------------------------------------------------------
  // Greedy assembly: walk the board from the best expected $/hour down and
  // take each plan (at the selected plan size) while both the total budget
  // and the weekly-hours budget still have room. What the leaders' boards
  // do not do: turn the ranking into one actionable plan in one click.
  function buildBasket() {
    var budget = Math.max(0, parseFloat($('bbudget').value) || 0);
    var hpw = Math.max(0, parseFloat($('bhours').value) || 0);
    var cands = rows.map(function (r) { return { r: r, e: econ(r) }; })
      .filter(function (x) { return x.e.net > 0; })
      .sort(function (a, b) { return b.e.perHour - a.e.perHour || a.r.rank - b.r.rank; });
    var picked = [], capital = 0, weekly = 0, net = 0, hours = 0;
    for (var i = 0; i < cands.length; i++) {
      var x = cands[i], load = x.e.hours / x.e.weeks;
      if (capital + plan > budget) continue;
      if (weekly + load > hpw) continue;
      picked.push(x); capital += plan; weekly += load; net += x.e.net; hours += x.e.hours;
    }
    $('bsummary').textContent = picked.length
      ? picked.length + ' plans · ' + fmt$(capital) + ' deployed · expected net ' + fmt$(net) + ' · ' + weekly.toFixed(1) + ' h/week · blended $' + (net / Math.max(hours, 0.01)).toFixed(1) + '/h'
      : 'Nothing fits — raise the budget or the hours, or lower the plan size.';
    $('btable').innerHTML = '<tr><th>#</th><th>Protocol</th><th>Plan</th><th>Expected net</th><th>$/hour</th><th>h/week</th><th>Verdict</th></tr>' +
      picked.map(function (x) {
        return '<tr><td>' + x.r.rank + '</td><td>' + esc(x.r.name) + '</td><td>' + fmt$(plan) + '</td><td>' + fmt$(x.e.net) +
          '</td><td>$' + x.e.perHour.toFixed(1) + '</td><td>' + (x.e.hours / x.e.weeks).toFixed(2) + '</td><td class="v-' + x.e.verdict + '">' + x.e.verdict + '</td></tr>';
      }).join('') +
      (picked.length ? '<tr class="tot"><td></td><td>Total</td><td>' + fmt$(capital) + '</td><td>' + fmt$(net) + '</td><td>$' + (net / Math.max(hours, 0.01)).toFixed(1) + '</td><td>' + weekly.toFixed(1) + '</td><td></td></tr>' : '');
  }
  $('bbuild').addEventListener('click', buildBasket);
  $('bbudget').addEventListener('input', buildBasket);
  $('bhours').addEventListener('input', buildBasket);
  buildBasket();

  // ---- hash routing (also how the screenshots were taken) -------------------
  var h = new URLSearchParams(location.hash.slice(1));
  if (h.get('tab')) { tab = h.get('tab');[...$('tabs').children].forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tab') === tab); }); }
  if (h.get('cat')) $('catf').value = h.get('cat');
  if (h.get('chain')) $('chainf').value = h.get('chain');
  if (h.get('q')) $('q').value = h.get('q');
  render();
  if (h.get('detail')) {
    document.body.classList.add('focus-detail');
    showDetail(h.get('detail'));
    document.querySelector('.controls').after($('detail'));
    window.scrollTo(0, 0);
  } else if (h.get('tab') || h.get('cat') || h.get('chain')) {
    document.body.classList.add('focus-board');
    window.scrollTo(0, 0);
  }
})();
