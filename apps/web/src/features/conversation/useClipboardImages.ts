import { useState, useSyncExternalStore } from 'react';
import { MAX_IMAGE_BYTES, MAX_PROMPT_IMAGES, type ImageAttachment } from '@agent-console/shared';
import { api } from '../../lib/api';

interface DraftImage {
  localId: string;
  file?: File;
  image?: ImageAttachment;
  error?: string;
}

// Keep unsent attachments when navigating away, just like composer text drafts.
const drafts = new Map<string, DraftImage[]>();
const listeners = new Set<() => void>();
const empty: DraftImage[] = [];

export function useClipboardImages(conversationKey: string, sessionId: string, csrfToken?: string) {
  const items = useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => drafts.get(conversationKey) ?? empty);
  const [error, setError] = useState<string>();

  function update(change: (current: DraftImage[]) => DraftImage[]): void {
    const next = change(drafts.get(conversationKey) ?? []);
    if (next.length) drafts.set(conversationKey, next); else drafts.delete(conversationKey);
    listeners.forEach(listener => listener());
  }

  async function upload(item: DraftImage): Promise<void> {
    if (!item.file) return;
    update(current => current.map(row => row.localId === item.localId ? { ...row, error: undefined } : row));
    try {
      const image = await api.uploadImage(sessionId, item.file, csrfToken);
      update(current => current.map(row => row.localId === item.localId ? { localId: row.localId, image } : row));
    } catch (failure) {
      update(current => current.map(row => row.localId === item.localId ? { ...row, error: failure instanceof Error ? failure.message : 'Image upload failed.' } : row));
    }
  }

  function paste(files: File[]): void {
    setError(undefined);
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        setError('Paste a PNG, JPEG or WebP image.');
        continue;
      }
      if (!file.size || file.size > MAX_IMAGE_BYTES) {
        setError('Images must be between 1 byte and 10 MiB.');
        continue;
      }
      if ((drafts.get(conversationKey)?.length ?? 0) >= MAX_PROMPT_IMAGES) {
        setError(`You can send up to ${MAX_PROMPT_IMAGES} images at a time.`);
        break;
      }
      const item = { localId: crypto.randomUUID(), file };
      update(current => [...current, item]);
      void upload(item);
    }
  }

  return {
    items, error, paste,
    ready: items.every(item => Boolean(item.image)),
    images: items.flatMap(item => item.image ? [item.image] : []),
    retry: upload,
    remove: (localId: string) => update(current => current.filter(item => item.localId !== localId)),
    clear: () => update(() => []),
  };
}
