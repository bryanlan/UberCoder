import { QueryClient } from '@tanstack/react-query';

// The API client and React share the same authentication cache.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: false,
    },
  },
});
