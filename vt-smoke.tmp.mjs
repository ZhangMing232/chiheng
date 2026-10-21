process.env.NODE_ENV = 'test';
const { probeVtTools, invokeVtTool } = await import('./src/lib/market/vt-tools.ts');
const t0 = Date.now();
const rep = await probeVtTools(true);
console.log('online:', rep.online, '| tools:', rep.toolCount, '| elapsed ms:', Date.now() - t0);
if (rep.error) console.log('error:', rep.error.slice(0, 300));
if (rep.tools?.length) console.log('sample:', rep.tools.slice(0, 3).map(t => t.name).join(', '));
if (rep.online) {
  const raw = await invokeVtTool('screen_market', { market: 'a', top_n: 5 }, 120_000);
  console.log('--- screen_market raw head ---');
  console.log(raw.slice(0, 400));
}
