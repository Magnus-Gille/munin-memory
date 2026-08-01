const CANONICAL_NEXT_STEPS_LABELS = new Set([
  "next steps",
  "next step",
  "next",
]);

function normalizeStatusLabelFragment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[*:_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCanonicalNextStepsLabel(raw: string): boolean {
  return CANONICAL_NEXT_STEPS_LABELS.has(normalizeStatusLabelFragment(raw));
}

function extractNextStepsValue(raw: string): string[] | undefined {
  const trimmed = raw.trim().replace(/^\\##(?=\s)/gm, "##");
  if (!trimmed) return undefined;

  const bulletItems = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  if (bulletItems.length > 0) return bulletItems;
  return [trimmed];
}

function findStructuredStatusNextSteps(content: string): { present: boolean; steps: string[] | undefined } {
  let present = false;
  let extracted: string[] | undefined;

  const headingMatches = [...content.matchAll(/^##\s+(.+)$/gm)];
  if (headingMatches.length > 0) {
    for (let i = 0; i < headingMatches.length; i++) {
      const match = headingMatches[i];
      const rawTitle = match[1].trim();
      if (!isCanonicalNextStepsLabel(rawTitle)) continue;
      present = true;
      const sectionStart = match.index! + match[0].length;
      const sectionEnd = i + 1 < headingMatches.length ? headingMatches[i + 1].index! : content.length;
      extracted = extractNextStepsValue(content.slice(sectionStart, sectionEnd));
    }
  }

  for (const line of content.split("\n")) {
    const inline = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
    if (!inline || !isCanonicalNextStepsLabel(inline[1])) continue;
    present = true;
    extracted = extractNextStepsValue(inline[2]);
  }

  return { present, steps: extracted };
}

export function extractStructuredStatusNextSteps(content: string): string[] | undefined {
  return findStructuredStatusNextSteps(content).steps;
}

export function hasStructuredStatusNextStepsSection(content: string): boolean {
  return findStructuredStatusNextSteps(content).present;
}

export const LEGACY_STATUS_NEXT_STEPS_HEADER =
  /^(?:#{1,6}\s+)?(?:next steps?|next|action items?|todo):?\s*$/i;

/**
 * Legacy plain status blobs have no machine-readable section terminator, so we
 * conservatively treat a supported header as running until the next markdown
 * heading or EOF. Counts matched blocks rather than bullet lines because
 * `exclusion_diagnostics` report matched candidate units, not full contents.
 */
export function countLegacyPlainStatusNextStepsSections(content: string): number {
  const lines = content.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || !LEGACY_STATUS_NEXT_STEPS_HEADER.test(trimmed)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      if (/^#{1,6}\s+/.test(next)) break;
      count += 1;
      break;
    }
  }
  return count;
}

export function hasLegacyPlainStatusNextSteps(content: string): boolean {
  return countLegacyPlainStatusNextStepsSections(content) > 0;
}
