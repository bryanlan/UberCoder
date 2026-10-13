/* Imported by the generated PWA service worker. */
self.addEventListener('push', event => {
  const message = event.data?.json();
  if (!message?.grantId) return;
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body, tag: `agent-grant-${message.grantId}`, requireInteraction: true,
    data: { grantId: message.grantId, url: message.url },
    actions: [{ action: 'approve', title: 'Approve' }, { action: 'edit', title: 'Edit' }, { action: 'deny', title: 'Deny' }],
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const { grantId, url } = event.notification.data;
    if (event.action === 'approve' || event.action === 'deny') {
      try {
        const auth = await fetch('/api/auth/me', { credentials: 'include' }).then(response => response.json());
        if (auth.authenticated && auth.csrfToken) {
          const response = await fetch(`/api/grants/${encodeURIComponent(grantId)}/decision`, {
            method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken },
            body: JSON.stringify({ decision: event.action }),
          });
          if (response.ok) return;
        }
      } catch { /* An expired login or unavailable connection opens the retained request. */ }
    }
    await self.clients.openWindow(url || `/grants?request=${encodeURIComponent(grantId)}`);
  })());
});
