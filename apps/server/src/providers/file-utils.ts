import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(input: string): Promise<boolean> {
  try {
    await fs.access(input);
    return true;
  } catch {
    return false;
  }
}

export async function listFilesRecursive(root: string, predicate: (absolutePath: string) => boolean): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && predicate(absolutePath)) {
        results.push(absolutePath);
      }
    }
  }

  await walk(root);
  return results.sort();
}

export async function readTextWindowed(filePath: string, maxBytes = 4_000_000): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size <= maxBytes) {
      return await handle.readFile({ encoding: 'utf8' });
    }
    const chunkSize = Math.floor(maxBytes / 2);
    const head = Buffer.alloc(chunkSize);
    const tail = Buffer.alloc(chunkSize);
    await handle.read(head, 0, chunkSize, 0);
    await handle.read(tail, 0, chunkSize, Math.max(0, stat.size - chunkSize));
    const headText = head.toString('utf8');
    const tailText = tail.toString('utf8');
    return [headText.slice(0, headText.lastIndexOf('\n')), tailText.slice(tailText.indexOf('\n') + 1)].join('\n');
  } finally {
    await handle.close();
  }
}

export async function readTextHead(filePath: string, maxBytes = 65_536): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const head = Buffer.alloc(length);
    await handle.read(head, 0, length, 0);
    return head.toString('utf8');
  } finally {
    await handle.close();
  }
}
