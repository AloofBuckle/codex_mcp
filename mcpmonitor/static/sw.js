'use strict';

const USER_INPUT_TAG_PREFIX = 'mws-user-input:';
const SETTINGS_CACHE = 'mcpmonitor-settings-v1';
const NOTIFICATIONS_PREF_URL = '/mcpmonitor/.notification-enabled';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function closeUserInputNotification(id) {
  const notifications = await self.registration.getNotifications({
    tag: USER_INPUT_TAG_PREFIX + id,
  });
  for (const notification of notifications) notification.close();
}

async function closeAllUserInputNotifications() {
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    if (String(notification.tag || '').startsWith(USER_INPUT_TAG_PREFIX)) notification.close();
  }
}

async function notificationPreference() {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const response = await cache.match(NOTIFICATIONS_PREF_URL);
    if (!response) return null;
    return (await response.text()) === '1';
  } catch {
    return null;
  }
}

async function setNotificationPreference(enabled) {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    await cache.put(
      NOTIFICATIONS_PREF_URL,
      new Response(enabled ? '1' : '0', { headers: { 'content-type': 'text/plain' } }),
    );
  } catch {}
}

async function monitorClients() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.filter((client) => {
    try {
      const url = new URL(client.url);
      return url.origin === self.location.origin && url.pathname.startsWith('/mcpmonitor/');
    } catch {
      return false;
    }
  });
}

async function currentAuthenticated() {
  try {
    const response = await fetch('/mcpmonitor/api/me', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.authenticated === true;
  } catch {
    return false;
  }
}

async function loadAuthenticatedUserInput(id) {
  id = String(id || '');
  if (!id) return null;
  try {
    const response = await fetch(`/mcpmonitor/api/user-input/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const request = await response.json();
    if (request?.terminal) return null;
    const first = Array.isArray(request?.questions) ? request.questions[0] : null;
    return {
      type: 'user_input',
      id,
      title: 'Codex 需要你的输入',
      body: first?.question || first?.title || '点击回答',
      url: `/mcpmonitor/?request=${encodeURIComponent(id)}`,
    };
  } catch {
    return null;
  }
}

async function showUserInput(data, { authChecked = false } = {}) {
  const id = String(data?.id || '');
  if (!id) return;
  if ((await notificationPreference()) === false) return;
  if (!authChecked && !(await currentAuthenticated())) return;
  const windows = await monitorClients();
  for (const client of windows) client.postMessage({ type: 'user-input-notify', request: data });
  await self.registration.showNotification(data.title || 'Codex 需要你的输入', {
    body: data.body || '点击回答',
    tag: USER_INPUT_TAG_PREFIX + id,
    renotify: true,
    requireInteraction: true,
    data: {
      type: 'user_input',
      id,
      capability: String(data.capability || ''),
      url: String(data.url || `/mcpmonitor/?request=${encodeURIComponent(id)}`),
    },
  });
}

async function resolveUserInput(data) {
  const id = String(data?.id || '');
  if (!id) return;
  await closeUserInputNotification(id);
  for (const client of await monitorClients()) {
    client.postMessage({ type: 'user-input-resolved', request: data });
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data?.json() || {};
      } catch {
        try {
          data = JSON.parse(event.data?.text() || '{}');
        } catch {
          return;
        }
      }
      if (data.type === 'user_input_resolved') await resolveUserInput(data);
      else if (data.type === 'user_input') {
        if ((await notificationPreference()) === false) return;
        const request = await loadAuthenticatedUserInput(data.id);
        if (request) await showUserInput(request, { authChecked: true });
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'show-user-input') event.waitUntil(showUserInput(data.request || {}));
  else if (data.type === 'resolve-user-input')
    event.waitUntil(resolveUserInput(data.request || {}));
  else if (data.type === 'enable-notifications') event.waitUntil(setNotificationPreference(true));
  else if (data.type === 'disable-notifications')
    event.waitUntil(
      (async () => {
        await setNotificationPreference(false);
        await closeAllUserInputNotifications();
      })(),
    );
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification?.data || {};
  const id = String(data.id || '');
  event.notification?.close();
  if (!id) return;
  event.waitUntil(
    (async () => {
      if (!(await currentAuthenticated())) return;
      const capability = String(data.capability || '');
      if (capability) {
        try {
          await fetch(`/mcpmonitor/widget/user-input/api/${encodeURIComponent(id)}/opened`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${capability}`,
              'content-type': 'application/json',
            },
            body: '{}',
            cache: 'no-store',
          });
        } catch {}
      } else {
        try {
          await fetch(`/mcpmonitor/api/user-input/${encodeURIComponent(id)}/opened`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            cache: 'no-store',
          });
        } catch {}
      }

      const target = String(data.url || `/mcpmonitor/?request=${encodeURIComponent(id)}`);
      const windows = await monitorClients();
      const client = windows[0];
      if (client) {
        client.postMessage({ type: 'open-user-input', id });
        try {
          await client.focus();
        } catch {}
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
