// Token Radar: reads the sealed snapshot, fits the launch-value and
// launch-odds models (lib/model.js), writes the ranked board, the
// dashboard with its embedded data, the screenshots, and the dossier.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import RadarModel from './lib/model.js';
import { buildDossier } from './vendor/makefun-board.ts';

const { buildBoard, boardChecksum } = RadarModel as any;

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const inputPath = argValue('--input', '/input/snapshot.json');
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || argValue('--output', '/output');

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
const board = buildBoard(snapshot);

mkdirSync(outputDir, { recursive: true });

// The board: gate fields first, then the radar's own numbers beside them.
const boardRows = board.rows.map((r) => ({
  slug: r.slug,
  name: r.name,
  rank: r.rank,
  implied_value_usd: Math.max(1, Math.round(r.implied)),
  farm_steps: r.econ.steps,
  tier: r.tier,
  category: r.category,
  chains: r.chains,
  tvl_usd: r.tvl,
  change_7d_pct: r.change7d,
  age_years: r.ageYears == null ? null : Math.round(r.ageYears * 100) / 100,
  launch_value_usd: Math.round(r.launchValue),
  launch_odds_pct: Math.round(r.odds * 1000) / 10,
  p25_usd: Math.round(r.p25),
  p75_usd: Math.round(r.p75),
  expected_months_to_token: r.months,
  farm_verdict: r.econ.verdict,
  farm_net_usd: Math.round(r.econ.net),
  farm_usd_per_hour: Math.round(r.econ.perHour * 100) / 100,
}));
writeFileSync(join(outputDir, 'board.json'), JSON.stringify({ rows: boardRows }, null, 1) + '\n');

// The dashboard, with its data written beside the page: the snapshot
// itself plus the integrity values the page checks its recompute against.
const dashOut = join(outputDir, 'dashboard');
cpSync(join(root, 'dashboard'), dashOut, { recursive: true });
const integrity = {
  rows: board.rows.length,
  checksum: boardChecksum(board.rows),
  totalImplied: boardRows.reduce((s, r) => s + r.implied_value_usd, 0),
  watchlist: board.accounting.watchlist,
  accounted: board.accounting.total,
};
writeFileSync(join(dashOut, 'zz-snapshot-data.js'),
  'window.RADAR_DATA=' + JSON.stringify({ snapshot: { as_of: snapshot.as_of, floor_usd: snapshot.floor_usd, protocols: snapshot.protocols, watchlist: snapshot.watchlist }, integrity }) + ';\n');

const shotsDir = join(root, 'screenshots');
if (existsSync(shotsDir)) cpSync(shotsDir, join(outputDir, 'screenshots'), { recursive: true });

const dossier = buildDossier(outputDir, { text_max_bytes: 65536 });
writeFileSync(join(outputDir, 'dossier.json'), Buffer.from(dossier));

console.log('token-radar: ' + board.rows.length + ' rows, watchlist ' + board.accounting.watchlist +
  '/40, checksum ' + integrity.checksum + ', LOO miss x' + board.value.looMiss.toFixed(2) +
  ', walk-forward x' + board.value.wfMiss.toFixed(2) + ', odds Brier ' + board.odds.brier.toFixed(3) +
  ' vs base ' + board.odds.brierBase.toFixed(3));
