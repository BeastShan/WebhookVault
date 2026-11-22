import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startLab } from './lab.js';
import { cases } from './scenario-cases.js';

const ignored = process.argv.slice(2).filter((key) => !Object.hasOwn(cases, key));
if (ignored.length) throw new Error('Scenario arguments must be letters A through G');
const chosen = process.argv.slice(2);
const output = resolve(process.env.VAULT_EVIDENCE_DIR ?? 'evidence/scenarios');
await mkdir(output, { recursive: true });
const lab = await startLab();
try {
  const postgres = (await lab.pool.query<{ version: string }>('SELECT version()')).rows[0].version;
  const run = { time: new Date().toISOString(), postgres, scenarios: [] as string[] };
  for (const [name, scenario] of Object.entries(cases)) {
    if (chosen.length && !chosen.includes(name)) continue;
    const evidence = await scenario(lab);
    await writeFile(resolve(output, `${name}.json`), JSON.stringify(evidence, null, 2));
    run.scenarios.push(name);
    console.log(`Scenario ${name} passed its assertions`);
  }
  await writeFile(resolve(output, 'run.json'), JSON.stringify(run, null, 2));
} finally {
  await lab.stop();
}
