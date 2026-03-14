import type { SessionScreen } from '@agent-console/shared';
import { normalizeWhitespace, stripAnsiAndControl } from '../lib/text.js';
import { nowIso } from '../lib/time.js';

interface ScreenLine {
  raw: string;
  plain: string;
}

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

function isLikelyFooterStatus(line: string): boolean {
  if (!line.trim()) {
    return false;
  }

  const normalized = normalizeWhitespace(line);
  if (!normalized || normalized.startsWith('/')) {
    return false;
  }

  if (/bypass permissions on/i.test(normalized)) {
    return true;
  }

  return /\b\d{1,3}% left\b/i.test(normalized)
    || (/·/.test(normalized) && /~[/\\]|\/home\/|\/Users\//.test(normalized));
}

function parsePromptInput(line: string): string | undefined {
  const match = line.match(/^\s*[❯›>]\s*(.+?)\s*$/u);
  if (!match) {
    return undefined;
  }
  const text = match[1]?.replace(/\u00a0/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (/^\d+\.\s/.test(text)) {
    return undefined;
  }
  return text;
}

function looksLikeMenuChoice(line: string): boolean {
  const normalized = normalizeWhitespace(line.replace(/^[❯›>]\s*/u, ''));
  return /^\/[\w-]/.test(normalized)
    || /^\d+\.\s/.test(normalized);
}

function isComposerBoundary(line: string): boolean {
  if (!line.trim()) {
    return true;
  }

  if (parsePromptInput(line) !== undefined) {
    return true;
  }

  if (/^\s*●/.test(line)) {
    return true;
  }

  if (/^\s*⎿/.test(line)) {
    return true;
  }

  if (looksLikeMenuChoice(line)) {
    return true;
  }

  return isLikelyFooterStatus(line);
}

function trimBlankEdges(lines: ScreenLine[]): ScreenLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.plain.trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.plain.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function collapseBlankRuns(lines: ScreenLine[]): ScreenLine[] {
  const collapsed: ScreenLine[] = [];
  for (const line of lines) {
    const blank = line.plain.trim().length === 0;
    const previousBlank = collapsed.at(-1)?.plain.trim().length === 0;
    if (blank && previousBlank) continue;
    collapsed.push(line);
  }
  return collapsed;
}

function joinPlain(lines: ScreenLine[]): string {
  return lines.map((line) => line.plain).join('\n').trim();
}

function joinAnsi(lines: ScreenLine[]): string {
  return lines.map((line) => line.raw).join('\n').trim();
}

function filterFooterStatusLines(lines: ScreenLine[]): ScreenLine[] {
  return lines.filter((line) => isLikelyFooterStatus(line.plain));
}

function toScreenLines(snapshot: string): ScreenLine[] {
  return snapshot
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((rawLine) => ({
      raw: rawLine,
      plain: trimRightPreservingIndentation(stripAnsiAndControl(rawLine)),
    }))
    .filter((line, index, all) => {
      if (index === 0 || index === all.length - 1) {
        return line.plain.trim().length > 0;
      }
      return true;
    });
}

function extractActiveInput(contentLines: ScreenLine[]): {
  contentLines: ScreenLine[];
  inputText: string;
  footerLines: ScreenLine[];
} {
  for (let index = contentLines.length - 1; index >= Math.max(0, contentLines.length - 12); index -= 1) {
    const promptText = parsePromptInput(contentLines[index]?.plain ?? '');
    if (promptText === undefined) {
      continue;
    }

    const following = contentLines.slice(index + 1).filter((line) => line.plain.trim().length > 0);
    if (following.some((line) => /^\s*●/.test(line.plain))) {
      continue;
    }

    const previous = contentLines.slice(0, index).reverse().find((line) => line.plain.trim().length > 0);
    if (previous && following.length > 0 && looksLikeMenuChoice(previous.plain) && following.every((line) => looksLikeMenuChoice(line.plain))) {
      continue;
    }

    const inputParts = [promptText];
    let nextSectionStart = index + 1;
    for (let lineIndex = index + 1; lineIndex < contentLines.length; lineIndex += 1) {
      const candidate = contentLines[lineIndex]!;
      if (isComposerBoundary(candidate.plain)) {
        nextSectionStart = lineIndex;
        break;
      }
      inputParts.push(candidate.plain.trim());
      nextSectionStart = lineIndex + 1;
    }

    const footerLines = collapseBlankRuns(trimBlankEdges(contentLines.slice(nextSectionStart)))
      .filter((line) => line.plain.trim().length > 0);

    return {
      contentLines: trimBlankEdges(contentLines.slice(0, index)),
      inputText: inputParts.join(' ').trim(),
      footerLines,
    };
  }

  return {
    contentLines,
    inputText: '',
    footerLines: [],
  };
}

export function parseSessionScreenSnapshot(snapshot: string, capturedAt = nowIso()): SessionScreen {
  const lines = toScreenLines(snapshot);

  const visibleLines = collapseBlankRuns(
    lines.filter((line, index) => {
      if (isBoxDrawingOnly(line.plain)) return false;
      if (index < 5 && isLeadingTerminalChrome(normalizeWhitespace(line.plain))) return false;
      return true;
    }),
  );

  let lastNonEmptyIndex = -1;
  for (let index = visibleLines.length - 1; index >= 0; index -= 1) {
    if (visibleLines[index]?.plain.trim().length) {
      lastNonEmptyIndex = index;
      break;
    }
  }

  if (lastNonEmptyIndex === -1) {
    return {
      content: 'Waiting for session output…',
      contentAnsi: 'Waiting for session output…',
      inputText: '',
      status: 'Starting session…',
      statusAnsi: 'Starting session…',
      capturedAt,
    };
  }

  const lastLine = visibleLines[lastNonEmptyIndex]!;
  const plainStatus = isLikelyFooterStatus(lastLine.plain)
    ? normalizeWhitespace(lastLine.plain)
    : 'Session active';
  const statusLineRaw = isLikelyFooterStatus(lastLine.plain) ? lastLine.raw.trim() : '';
  const contentEndExclusive = plainStatus === 'Session active'
    ? visibleLines.length
    : lastNonEmptyIndex;
  const baseContentLines = collapseBlankRuns(visibleLines.slice(0, contentEndExclusive)).filter((line, index, all) => {
    if (all.length === 0) return false;
    if (plainStatus !== 'Session active' && index === all.length - 1 && normalizeWhitespace(line.plain) === plainStatus) return false;
    return true;
  });

  const { contentLines, inputText, footerLines } = extractActiveInput(baseContentLines);
  const trailingStatusLines = plainStatus === 'Session active' ? [] : [lastLine];
  const footerStatusLines = filterFooterStatusLines([...footerLines, ...trailingStatusLines]);
  const nonStatusFooterLines = footerLines.filter((line) => !isLikelyFooterStatus(line.plain));
  const visibleContentLines = trimBlankEdges(collapseBlankRuns([...contentLines, ...nonStatusFooterLines]));
  const content = joinPlain(visibleContentLines) || 'Waiting for session output…';
  const contentAnsi = joinAnsi(visibleContentLines) || content;
  const footerText = joinPlain(footerStatusLines);
  const footerAnsi = joinAnsi(footerStatusLines);

  return {
    content,
    contentAnsi,
    inputText,
    status: footerText || plainStatus,
    statusAnsi: footerAnsi || statusLineRaw || plainStatus,
    capturedAt,
  };
}
