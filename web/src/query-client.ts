import { QueryClient } from '@tanstack/react-query';

// One cache of server data for the whole app. Reads from outside React (say, after
// a save) go through it too, so every screen sees the same copy.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A screen opening shortly after another loaded the same data uses that copy
      staleTime: 10_000,
      retry: 1,
    },
  },
});
