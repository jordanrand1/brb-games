import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
assert.notEqual(process.getuid(), 0, 'Container application must run as an unprivileged user');
const child = spawn(process.execPath, ['--experimental-sqlite', '--experimental-strip-types', 'src/server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (data) => output += data); child.stderr.on('data', (data) => output += data);
try {
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch('http://127.0.0.1:8787/healthz')).ok) { healthy = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(healthy, output);
  const response = await fetch('http://127.0.0.1:8787/api/control', { method: 'POST', headers: { Origin: 'http://localhost:8787', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'context', secret: 'tiger' }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).state.privateTarget, 'tiger');
  console.log('Container smoke passed: unprivileged runtime, writable data mount, health check, game start.');
} finally { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
