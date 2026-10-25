// Cross-entropy search over trained-market parameters, scored in the reactive self-play simulator (one candidate seat vs five hold-seven clones).
// Usage: node --import tsx src/selfplay-search.ts --out runs/selfplay-search-01 --generations 3 --population 16 --matches 150
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = flag('--out', 'runs/selfplay-search-01'), GENS = Number(flag('--generations', '3')), POP = Number(flag('--population', '16')), MATCHES = Number(flag('--matches', '150'));
const LO = [0.55, 0.55, 0.55, 10, 0, 0.45], HI = [1.45, 1.45, 1.45, 35, 1.4, 1];
let mean = [1, 1, 1, 10, 0.4, 1], sigma = [0.15, 0.15, 0.15, 5, 0.3, 0.15];
fs.mkdirSync(OUT, { recursive: true });
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const random = rng(2026);
const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const clamp = (v: number, i: number) => Math.min(HI[i], Math.max(LO[i], v));
function evaluate(params: number[], seed: number, file: string): Promise<{ place: number; score: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'src/sim-selfplay.ts', '--matches', String(MATCHES), '--seed', String(seed), '--out', file,
      'src/experiment-gain-policy.ts', ...Array(5).fill('src/experiment-hold-word.ts')],
      { env: { ...process.env, GAIN_PARAMS: JSON.stringify(params), POLICY_MODEL: process.env.POLICY_MODEL ?? 'runs/top3-known-live/selected.json' }, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`sim exited ${code}`));
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      const t = r.table.find((x: any) => /gain-policy/.test(x.policy)), h = r.table.find((x: any) => /hold-word/.test(x.policy));
      resolve({ place: t.meanPlace - h.meanPlace, score: t.meanScore - h.meanScore });
    });
  });
}
const history: any[] = [];
for (let g = 0; g < GENS; g++) {
  const candidates = Array.from({ length: POP }, (_, k) => k === 0 && g === 0 ? [...mean] : mean.map((m, i) => +clamp(m + sigma[i] * gauss(), i).toFixed(3)));
  const results = await Promise.all(candidates.map((p, k) => evaluate(p, 1000 * g + k + 1, `${OUT}/g${g}-c${k}.json`).then(r => ({ params: p, ...r }))));
  results.sort((a, b) => a.place - b.place);
  const elite = results.slice(0, Math.max(2, Math.floor(POP / 4)));
  mean = mean.map((_, i) => +(elite.reduce((s, e) => s + e.params[i], 0) / elite.length).toFixed(3));
  sigma = sigma.map(s => +(s * 0.8).toFixed(3));
  history.push({ generation: g, best: results[0], elite, mean, sigma });
  fs.writeFileSync(`${OUT}/status.json`, JSON.stringify({ generation: g, mean, sigma, best: results[0], history }, null, 1));
  console.log(`gen ${g}: best place diff ${results[0].place.toFixed(3)} (score diff ${results[0].score.toFixed(2)}) params ${JSON.stringify(results[0].params)}; new mean ${JSON.stringify(mean)}`);
}
