import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { AppDatabase } from "../src/database.ts";
import { Rooms } from "../src/rooms.ts";
import { lexicon } from "../src/embeddings.ts";

const directory = mkdtempSync(join(tmpdir(), "brb-load-"));
const database = new AppDatabase(directory, "load-test-key");
const rooms = new Rooms(database, { clientId: "", clientSecret: "", aiKey: "", allowed: () => true });
class Sink extends EventEmitter {
  destroyed = false; writableEnded = false; writableLength = 0; bytes = 0;
  write(value: string) { this.bytes += Buffer.byteLength(value); }
  end() { this.writableEnded = true; this.emit("close"); }
  destroy() { this.destroyed = true; this.end(); }
}
const sinks: Sink[] = [], latencies: number[] = [];
let peak = process.memoryUsage().rss;
const started = performance.now();
try {
  for (let channel = 0; channel < 10; channel++) {
    const room = rooms.get("load-" + channel);
    for (const view of ["control", "public", "public"] as const) { const sink = new Sink(); sinks.push(sink); rooms.attach(room, { response: sink, view }); }
    room.game.startContext(undefined, 300);
  }
  assert.throws(() => rooms.get("eleventh"), /capacity/);
  // 50 submitted guesses per second across 10 games for 20 seconds.
  for (let batch = 0; batch < 100; batch++) {
    const batchStart = performance.now();
    for (let request = 0; request < 10; request++) {
      const room = rooms.rooms.get("load-" + request)!;
      const word = lexicon[(batch * 17 + request) % lexicon.length]!;
      const before = performance.now();
      await rooms.chat(room, { broadcaster_user_id: room.id, chatter_user_login: "viewer" + batch, chatter_user_name: "Viewer " + batch, message: { text: word } });
      latencies.push(performance.now() - before);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 200 - (performance.now() - batchStart))));
  }
  latencies.sort((a, b) => a - b);
  const report = { channels: rooms.rooms.size, clients: sinks.length, guesses: latencies.length, elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)), p95GuessMs: Number(latencies[Math.floor(latencies.length * .95)]!.toFixed(2)), maximumGuessMs: Number(latencies.at(-1)!.toFixed(2)), peakRssMiB: Number((peak / 1024 / 1024).toFixed(2)), streamedBytes: sinks.reduce((sum, sink) => sum + sink.bytes, 0) };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.peakRssMiB < 400, "Memory must stay below 400 MiB before opening ten-channel beta.");
  assert.ok(report.p95GuessMs < 1000, "95% of guesses must finish within a second.");
} finally { rooms.dispose(); database.close(); rmSync(directory, { recursive: true, force: true }); }
