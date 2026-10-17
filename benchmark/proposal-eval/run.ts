import {
  buildNotRunEnvelope,
  loadProposalEvalDataset,
  runDeterministicBaseline,
} from "./evaluate.js";

const dataset = loadProposalEvalDataset();
const output = {
  deterministic_baseline: await runDeterministicBaseline(dataset),
  general_model_recorded: buildNotRunEnvelope(dataset, "general_model_recorded"),
  hy_memory_recorded: buildNotRunEnvelope(dataset, "hy_memory_recorded"),
  protocol: "proposal-only; thresholds and labels pending human review; no model or hardware evaluation performed",
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
