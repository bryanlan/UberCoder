import type { SessionScreen } from '@agent-console/shared';
import { normalizeWhitespace, stripAnsiAndControl } from '../lib/text.js';
import { nowIso } from '../lib/time.js';

function trimRightPreservingIndentation(line: string): string {
  return line.replace(/\s+$/g, '');
}

function isBoxDrawingOnly(line: string): boolean {
  return /^[\s│╭╮╰╯─┌┐└┘├┤┬┴┼█▛▜▐▌▝▘]+$/u.test(line);
}

function isLeadingTerminalChrome(line: string): boolean {
  return /(?:^|\s)(?:OpenAI Codex|Claude Code|Use \/model to change|Use \/skills to list available|loading \/model to change)/i.test(line)
    || /^(?:Model:|Directory:|Approval:|Sandbox:|Context window:)/i.test(line)
    || /^(?:Use medium effort|with medium effort|We recommend .+ effort|Effort determines|recommend .+ effort for most tasks|and maximize rate limits|Use ultrathink)/i.test(line);
}

function collapseBlankRuns(lines: string[]): string[] {
  const collapsed: string[] = [];
  for (const line of lines) {
    const blank = line.trim().length === 0;
    const previousBlank = collapsed.at(-1)?.trim().length === 0;
    if (blank && previousBlank) continue;
    collapsed.push(line);
  }
  return collapsed;
}

export function parseSessionScreenSnapshot(snapshot: string, capturedAt = nowIso()): SessionScreen {
  const lines = stripAnsiAndControl(snapshot)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => trimRightPreservingIndentation(line))
    .filter((line, index, all) => {
      if (index === 0 || index === all.length - 1) {
        return line.trim().length > 0;
      }
      return true;
    });

  const visibleLines = collapseBlankRuns(
    lines.filter((line, index) => {
      if (isBoxDrawingOnly(line)) return false;
      if (index < 5 && isLeadingTerminalChrome(normalizeWhitespace(line))) return false;
      return true;
    }),
  );

  let lastNonEmptyIndex = -1;
  for (let index = visibleLines.length - 1; index >= 0; index -= 1) {
    if (visibleLines[index]?.trim().length) {
      lastNonEmptyIndex = index;
      break;
    }
  }
  if (lastNonEmptyIndex === -1) {
    return {
      content: 'Waiting for session output…',
      status: 'Starting session…',
      capturedAt,
    };
  }

  const status = normalizeWhitespace(visibleLines[lastNonEmptyIndex] ?? '') || 'Session active';
  const contentLines = collapseBlankRuns(visibleLines.slice(0, lastNonEmptyIndex)).filter((line, index, all) => {
    if (all.length === 0) return false;
    if (index === all.length - 1 && normalizeWhitespace(line) === status) return false;
    return true;
  });
  const content = contentLines.join('\n').trim() || 'Waiting for session output…';

  return { content, status, capturedAt };
}
