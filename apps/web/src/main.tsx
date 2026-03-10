import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import './styles/index.css';

const isLoopbackHost = (() => {
  if (typeof window === 'undefined') {
    return false;
  }
  const { hostname } = window.location;
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.');
})();

async function disablePwaForLocalhost() {
  if (typeof window === 'undefined') {
    return;
  }

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  if ('caches' in window) {
    const cacheKeys = await window.caches.keys();
    await Promise.all(cacheKeys.map((cacheKey) => window.caches.delete(cacheKey)));
  }

  const reloadKey = 'agent-console:localhost-sw-reset:v1';
  if (navigator.serviceWorker.controller && !window.sessionStorage.getItem(reloadKey)) {
    window.sessionStorage.setItem(reloadKey, '1');
    window.location.reload();
    return;
  }
  window.sessionStorage.removeItem(reloadKey);
}

if (isLoopbackHost) {
  void disablePwaForLocalhost();
} else {
  registerSW({ immediate: true });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
