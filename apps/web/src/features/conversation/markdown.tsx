import type { ReactNode } from 'react';

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`${match.index}:code`} className="font-mono text-[0.92em] text-inherit">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<strong key={`${match.index}:bold`} className="font-semibold text-inherit">{token.slice(2, -2)}</strong>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function renderInlineLines(lines: string[]): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...renderInlineMarkdown(line),
    ...(index < lines.length - 1 ? [<br key={`br:${index}`} />] : []),
  ]);
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^```/.test(trimmed)
    || /^#{1,4}\s+/.test(trimmed)
    || /^[-*_]{3,}$/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^[-*]\s+/.test(trimmed)
    || /^\d+[.)]\s+/.test(trimmed);
}

export function renderMessageMarkdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test((lines[index] ?? '').trim())) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(
        <pre key={`code:${index}`} className="my-3 overflow-x-auto border-l border-current pl-3 text-xs leading-5 text-inherit">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      blocks.push(
        <div key={`heading:${index}`} className="mt-4 text-base font-semibold text-inherit first:mt-0">
          {renderInlineMarkdown(headingMatch[2] ?? '')}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      blocks.push(<div key={`rule:${index}`} className="my-4 border-t border-slate-800" />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test((lines[index] ?? '').trim())) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote:${index}`} className="my-3 pl-3 text-inherit">
          {renderInlineLines(quoteLines)}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul:${index}`} className="my-3 list-disc space-y-1 pl-5">
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test((lines[index] ?? '').trim())) {
        items.push((lines[index] ?? '').trim().replace(/^\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol:${index}`} className="my-3 list-decimal space-y-1 pl-5">
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
        </ol>,
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() && !isMarkdownBlockStart(lines[index] ?? '')) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(
      <p key={`p:${index}`} className="my-3 first:mt-0 last:mb-0">
        {renderInlineLines(paragraphLines)}
      </p>,
    );
  }

  return blocks.length > 0 ? blocks : [text];
}
