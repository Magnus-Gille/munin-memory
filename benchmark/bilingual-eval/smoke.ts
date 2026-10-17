import { readFileSync } from "node:fs";
import { compareRuns, makeSmokeRun, MODES, parseFixture } from "./index.js";

const fixture = parseFixture(JSON.parse(readFileSync(
  new URL("./synthetic.candidates.json", import.meta.url), "utf8",
)));
const reports = MODES.map(mode => {
  const recorded = makeSmokeRun(fixture, mode);
  return compareRuns(fixture, recorded, recorded, "repeat");
});
process.stdout.write(JSON.stringify({
  warning: "Fabricated rankings test offline plumbing only. No human labels, model inference or hardware measurements were produced.",
  reports,
}, null, 2) + "\n");
