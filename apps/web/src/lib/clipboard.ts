export async function copyTextToClipboard(text: string): Promise<void> {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }

  const textarea = globalThis.document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  globalThis.document.body.appendChild(textarea);
  textarea.select();
  globalThis.document.execCommand('copy');
  globalThis.document.body.removeChild(textarea);
}
