"use client";

import { SWRConfig } from "swr";

// App-wide SWR defaults. `revalidateOnFocus` is the key behaviour for our
// stale-route complaints: returning to a tab (or re-focusing the window after
// changing status elsewhere) refetches every mounted key, so routes can't show
// data that another route already changed.
export function SwrProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        dedupingInterval: 4000
      }}
    >
      {children}
    </SWRConfig>
  );
}
