import { normalizeWhitespace } from './text.js';

export function looksLikeDiffMarker(trimmedLine: string): boolean {
  return /^(?:diff --git|index [0-9a-f]+\.\.|@@|[+-]{3}\s|[*]{3}\s|---\s)/.test(trimmedLine);
}

export function looksLikeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (looksLikeDiffMarker(trimmed)) return true;
  if (/^(?:import|export)\s+.+\s+from\s+['"]/.test(trimmed)) return true;
  if (
    /^(?:import|export|const|let|var|function|class|interface|type|enum|return|if|for|while|switch|case|try|catch|async|await)\b/.test(trimmed)
    && /[{}()[\];=]|=>/.test(trimmed)
  ) return true;
  if (/^(?:[{}()[\];,]|<\/?[A-Za-z][^>]*>)$/.test(trimmed)) return true;
  if (/^[A-Za-z0-9_$.-]+\([^)]*\)\s*[{:;]?$/.test(trimmed)) return true;
  if (/^\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_$.-]+)\s*:\s*["'{[\d]/.test(line)) return true;
  if (/[{};][\s)]*$/.test(trimmed) && /[=()[\]{};]/.test(trimmed)) return true;
  if (/^\s{2,}\S/.test(line) && /[=()[\]{};]/.test(trimmed)) return true;
  return false;
}

function looksLikePythonTracebackStart(trimmedLine: string): boolean {
  return /^Traceback \(most recent call last\):$/.test(trimmedLine);
}

function looksLikePythonStackFrame(trimmedLine: string): boolean {
  return /^File ["'][^"']+["'], line \d+, in .+/.test(trimmedLine);
}

function looksLikeStackExceptionLine(trimmedLine: string): boolean {
  return /^(?:Error|[A-Za-z_][\w.]*Error|[A-Za-z_][\w.]*Exception|Exception|KeyboardInterrupt|SystemExit)(?::|\b)/.test(trimmedLine);
}

function looksLikeJavaScriptStackFrame(trimmedLine: string): boolean {
  return /^at\s+(?:async\s+)?(?:.+\s+\()?[^)]*:\d+:\d+\)?$/.test(trimmedLine);
}

function startsJavaScriptStack(lines: string[], index: number, trimmedLine: string): boolean {
  if (!looksLikeStackExceptionLine(trimmedLine)) {
    return false;
  }
  const nextLine = lines.slice(index + 1).find((line) => line.trim());
  return nextLine ? looksLikeJavaScriptStackFrame(nextLine.trim()) : false;
}

export function stripCodeLikeContent(text: string): string {
  const withoutFences = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]{1,120}`/g, ' ');
  const lines = withoutFences.split(/\r?\n/);
  const kept: string[] = [];
  let omittedCodeLines = 0;
  let insideDiff = false;
  let insideStackTrace: 'javascript' | 'python' | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (insideStackTrace) {
      if (!trimmed) {
        insideStackTrace = undefined;
        kept.push(line);
        continue;
      }
      if (insideStackTrace === 'python') {
        omittedCodeLines += 1;
        if (looksLikeStackExceptionLine(trimmed)) {
          insideStackTrace = undefined;
        }
        continue;
      }
      if (looksLikeJavaScriptStackFrame(trimmed)) {
        omittedCodeLines += 1;
        continue;
      }
      insideStackTrace = undefined;
    }
    if (looksLikePythonTracebackStart(trimmed)) {
      insideStackTrace = 'python';
      omittedCodeLines += 1;
      continue;
    }
    if (looksLikePythonStackFrame(trimmed) || startsJavaScriptStack(lines, index, trimmed)) {
      insideStackTrace = looksLikePythonStackFrame(trimmed) ? 'python' : 'javascript';
      omittedCodeLines += 1;
      continue;
    }
    if (looksLikeDiffMarker(trimmed)) {
      insideDiff = true;
      omittedCodeLines += 1;
      continue;
    }
    if (insideDiff && !trimmed) {
      insideDiff = false;
      kept.push(line);
      continue;
    }
    if (insideDiff && /^[+-]/.test(line)) {
      omittedCodeLines += 1;
      continue;
    }
    if (insideDiff && (line.startsWith(' ') || line.startsWith('\\'))) {
      omittedCodeLines += 1;
      continue;
    }
    if (insideDiff && trimmed && !line.startsWith(' ')) {
      insideDiff = false;
    }
    if (looksLikeCodeLine(line)) {
      omittedCodeLines += 1;
      continue;
    }
    kept.push(line);
  }

  const prose = kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n{2,}/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean)
    .join('\n');

  if (!prose && omittedCodeLines > 0) {
    return '';
  }

  return prose;
}

export function sanitizeSearchableProse(text: string): string {
  return stripCodeLikeContent(text)
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line && !looksLikeCodeLine(line))
    .join('\n')
    .trim();
}
