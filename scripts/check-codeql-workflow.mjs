/** Validate that the CodeQL init and analyze actions use one immutable revision. */
export function validateCodeqlWorkflow(workflow) {
  const actions = ["init", "analyze"];
  const pins = new Map();

  const activeUses = [];
  for (const line of workflow.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // A step's `uses` can start the mapping or follow metadata such as `name`.
    // Quoted references are accepted; trailing comments are ignored.
    const useLine = line.match(/^\s*(?:-\s+)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#.*)?\s*$/);
    if (!useLine) continue;
    const reference = useLine[1] ?? useLine[2] ?? useLine[3];
    const codeqlAction = reference.match(/^github\/codeql-action\/(init|analyze)@(.+)$/);
    if (codeqlAction) activeUses.push({ action: codeqlAction[1], revision: codeqlAction[2] });
  }

  for (const action of actions) {
    const matches = activeUses.filter((use) => use.action === action);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one github/codeql-action/${action} use; found ${matches.length}.`);
    }

    const revision = matches[0].revision;
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      throw new Error(`github/codeql-action/${action} must use a full 40-character lowercase commit SHA; found ${revision}.`);
    }
    pins.set(action, revision);
  }

  if (pins.get("init") !== pins.get("analyze")) {
    throw new Error("CodeQL init and analyze must use the same commit SHA.");
  }

  return pins;
}
