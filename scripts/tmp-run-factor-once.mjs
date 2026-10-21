process.env.NODE_ENV = 'production';
const { runFactorAILoop } = await import('../src/lib/market/factor-queue.ts');
const { readFactorRuns } = await import('../src/lib/market/factor-runs-file.ts');
const { FACTORS } = await import('../src/lib/market/factors.ts');
const t0 = Date.now();
const r = await runFactorAILoop(
  { readRows: readFactorRuns, existingFactors: FACTORS.map((f) => ({ id: f.id, name: f.name })) },
  'manual',
);
console.log(JSON.stringify({ ...r, elapsedMs: Date.now() - t0 }, null, 1).slice(0, 2500));
