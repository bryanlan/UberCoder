import { expect, test } from '@playwright/test';
import type { ImageAttachment, NormalizedMessage, ProviderId, SessionKeystrokeRequest } from '@agent-console/shared';

const image: ImageAttachment = {
  id: '8299dab4-7c25-4245-a7dd-859945e63d51', mediaType: 'image/png', name: 'Pasted image.png',
  width: 1, height: 1, sizeBytes: 68,
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');

for (const provider of ['claude', 'codex'] as const satisfies readonly ProviderId[]) {
  for (const bypass of [false, true]) {
    test(`${provider} clipboard image with ${bypass ? 'Text Bypass' : 'normal input'} survives rejection and reloads in history`, async ({ page }) => {
      const timestamp = new Date().toISOString();
      const session = { id: 'image-session', provider, projectSlug: 'demo', conversationRef: 'image-chat', tmuxSessionName: 'fixture', status: 'bound', startedAt: timestamp, updatedAt: timestamp, shouldRestore: true };
      const conversation = { ref: 'image-chat', provider, projectSlug: 'demo', kind: 'history', title: 'Image fixture', updatedAt: timestamp, isBound: true, boundSessionId: session.id, degraded: false };
      const messages: NormalizedMessage[] = [];
      const submissions: SessionKeystrokeRequest[] = [];
      let uploads = 0;
      let rejectNext = true;
      await page.route('**/api/auth/me', route => route.fulfill({ json: { authenticated: true, csrfToken: 'fixture-csrf' } }));
      await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
      await page.route('**/api/settings/ui-preferences', route => route.fulfill({ json: { recentActivitySortEnabled: true, manualProjectOrder: [] } }));
      await page.route('**/api/assignment-activity**', route => route.fulfill({ status: 404, json: {} }));
      await page.route('**/api/projects/tree', route => route.fulfill({ json: {
        projects: [{ slug: 'demo', directoryName: 'demo', displayName: 'Demo', path: '/tmp/demo', tags: [], allowedLocalhostPorts: [], providers: {
          codex: { id: 'codex', label: 'Codex', conversations: provider === 'codex' ? [conversation] : [] },
          claude: { id: 'claude', label: 'Claude', conversations: provider === 'claude' ? [conversation] : [] },
        } }], boundSessions: [session],
      } }));
      await page.route(`**/api/conversations/demo/${provider}/image-chat/messages**`, route => route.fulfill({ json: { conversation, boundSession: session, messages, messagePage: { hasOlder: false, total: messages.length } } }));
      await page.route('**/api/sessions/image-session/screen**', route => route.fulfill({ json: { session, screen: { content: 'Ready', inputText: '', capturedAt: timestamp, status: provider === 'codex' ? 'gpt-6.1-sol · 80% left' : '⏵⏵ bypass permissions on' } } }));
      await page.route('**/api/sessions/image-session/images', async route => {
        uploads++;
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
        expect(route.request().headers()['content-type']).toBe('image/png');
        expect(route.request().postDataBuffer()).toEqual(png);
        await route.fulfill({ status: 201, json: { image } });
      });
      await page.route(`**/api/images/${image.id}`, route => route.fulfill({ contentType: 'image/png', body: png }));
      await page.route('**/api/sessions/image-session/keys', async route => {
        const body = route.request().postDataJSON() as SessionKeystrokeRequest;
        if (!body.keys?.includes('Enter')) return route.fulfill({ json: { session } });
        submissions.push(body);
        if (rejectNext) {
          rejectNext = false;
          return route.fulfill({ status: 409, json: { error: 'Fixture rejected input' } });
        }
        const text = body.submittedText ?? '';
        messages.push({ id: 'image-message', provider, role: 'user', lifecycle: 'durable', text, images: [image], timestamp, conversationRef: conversation.ref, source: 'history-file' });
        await route.fulfill({ json: { session, recordedUserInput: { id: 'image-message', text, images: [image], timestamp } } });
      });
      await page.goto(`/projects/demo/${provider}/image-chat`);
      const textbox = page.getByRole('textbox');
      await expect(textbox).toBeVisible();
      if (bypass) {
        await page.getByRole('button', { name: 'Text Bypass', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Text Bypass', exact: true })).toHaveAttribute('aria-pressed', 'true');
      }
      await textbox.evaluate((element, bytes) => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([new Uint8Array(bytes)], 'clipboard.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, [...png]);
      await expect(page.getByAltText(image.name)).toBeVisible();
      await textbox.press('Enter');
      await expect(page.getByText('Fixture rejected input')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove attached image' })).toBeVisible();
      await textbox.press('Enter');
      await expect(page.getByRole('button', { name: 'Remove attached image' })).toHaveCount(0);
      await expect(page.locator('article img')).toHaveAttribute('src', `/api/images/${image.id}`);
      expect(uploads).toBe(1);
      expect(submissions).toHaveLength(2);
      expect(submissions.every(body => body.imageIds?.[0] === image.id)).toBe(true);
      await page.reload();
      await expect(page.locator('article img')).toHaveAttribute('src', `/api/images/${image.id}`);
    });
  }
}
