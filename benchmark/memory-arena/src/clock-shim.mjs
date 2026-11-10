// Harness-only clock shim for the Munin arm (loaded with `node --import`). It shifts the
// process clock so that entries written during a replayed conversation carry that
// conversation's date. Munin's code is not modified. The harness writes an ISO timestamp to
// $ARENA_CLOCK_FILE; an empty file means real time. Offsets apply to `new Date()` and Date.now().
import fs from 'node:fs';

const RealDate = Date;
const file = process.env.ARENA_CLOCK_FILE;
let offset = 0;

function load() {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    offset = t ? RealDate.parse(t) - RealDate.now() : 0;
  } catch {
    offset = 0;
  }
}

if (file) {
  load();
  const w = fs.watchFile(file, { interval: 50 }, load);
  w.unref?.();
  class ArenaDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ArenaDate;
}
