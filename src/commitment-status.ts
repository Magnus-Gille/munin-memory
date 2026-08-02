const CANONICAL_NEXT_STEPS_LABELS = new Set([
  "next steps",
  "next step",
  "next",
]);
const CANONICAL_STATUS_LABELS = new Set([
  "phase",
  "current work",
  "current",
  "blockers",
  "blocker",
  "next steps",
  "next step",
  "next",
  "notes",
  "note",
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

function isCanonicalStatusLabel(raw: string): boolean {
  return CANONICAL_STATUS_LABELS.has(normalizeStatusLabelFragment(raw));
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

function isCanonicalInlineStatusLine(line: string): boolean {
  const inline = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
  return Boolean(inline && isCanonicalStatusLabel(inline[1]));
}

function hasCanonicalStructuredStatus(content: string): boolean {
  const headingMatches = [...content.matchAll(/^##\s+(.+)$/gm)];
  if (headingMatches.some((match) => isCanonicalStatusLabel(match[1].trim()))) {
    return true;
  }
  return content.split("\n").some((line) => isCanonicalInlineStatusLine(line.trim()));
}

export function extractStructuredStatusNextSteps(content: string): string[] | undefined {
  return findStructuredStatusNextSteps(content).steps;
}

export function hasStructuredStatusNextStepsSection(content: string): boolean {
  return findStructuredStatusNextSteps(content).present;
}

export const LEGACY_STATUS_NEXT_STEPS_HEADER =
  /^(?:#{1,6}\s+)?(?:next steps?|next|action items?|todo):?\s*$/i;

const LEGACY_STATUS_CONTEXT_LINE =
  /^(?:phase|current work|blockers|status|lifecycle)\s*:\s*\S/i;

function hasLegacyStatusContextBefore(lines: string[], headerIndex: number): boolean {
  return lines
    .slice(0, headerIndex)
    .some((line) => LEGACY_STATUS_CONTEXT_LINE.test(line.trim()));
}

interface LegacyPlainStatusNextStepsBlock {
  startLine: number;
  endLineExclusive: number;
}

function findLegacyPlainStatusNextStepsBlocks(content: string): LegacyPlainStatusNextStepsBlock[] {
  const lines = content.split("\n");
  const hasCanonicalStructure = hasCanonicalStructuredStatus(content);
  const blocks: LegacyPlainStatusNextStepsBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || !LEGACY_STATUS_NEXT_STEPS_HEADER.test(trimmed)) continue;
    if (!hasLegacyStatusContextBefore(lines, i)) continue;
    if (hasCanonicalStructure && /^#{1,6}\s+/.test(trimmed)) continue;

    let endLineExclusive = i + 1;
    let sawBody = false;
    let bodyMode: "bullet" | "plain" | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const nextRaw = lines[j];
      const next = nextRaw.trim();

      if (!next) {
        if (sawBody) break;
        continue;
      }
      if (/^#{1,6}\s+/.test(next) || LEGACY_STATUS_CONTEXT_LINE.test(next) || isCanonicalInlineStatusLine(next)) {
        break;
      }

      const isBulletLine = /^\s*[-*]\s+\S/.test(nextRaw);
      const isIndentedContinuation = /^\s{2,}\S/.test(nextRaw);
      if (!sawBody) {
        sawBody = true;
        bodyMode = isBulletLine ? "bullet" : "plain";
      } else if (bodyMode === "bullet" && !isBulletLine && !isIndentedContinuation) {
        break;
      }

      endLineExclusive = j + 1;
    }

    if (!sawBody) continue;
    blocks.push({ startLine: i, endLineExclusive });
    i = endLineExclusive - 1;
  }

  return blocks;
}

export function stripLegacyPlainStatusNextSteps(content: string): string {
  const blocks = findLegacyPlainStatusNextStepsBlocks(content);
  if (blocks.length === 0) return content;

  const lines = content.split("\n");
  const kept: string[] = [];
  let blockIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    while (blockIndex < blocks.length && i >= blocks[blockIndex].endLineExclusive) {
      blockIndex += 1;
    }
    if (blockIndex < blocks.length && i >= blocks[blockIndex].startLine && i < blocks[blockIndex].endLineExclusive) {
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

/**
 * Legacy plain status blobs are counted as whole next-step blocks, not bullet
 * lines, because `exclusion_diagnostics` report matched candidate units rather
 * than full bodies or individual bullets.
 */
export function countLegacyPlainStatusNextStepsSections(content: string): number {
  return findLegacyPlainStatusNextStepsBlocks(content).length;
}

export function hasLegacyPlainStatusNextSteps(content: string): boolean {
  return countLegacyPlainStatusNextStepsSections(content) > 0;
}
