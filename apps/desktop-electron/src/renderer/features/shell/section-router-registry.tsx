/* eslint-disable react-refresh/only-export-components -- This module intentionally owns the process-lifetime router registry and its React projections. */
import * as React from "react";
import {
  createMemoryRouter,
  RouterProvider,
  type NavigationType,
  type RouteObject,
} from "react-router";

import type { RendererShellSection } from "@/features/shell/context-pane-contract";
import {
  SectionRouteLayout,
  SectionRoutePage,
} from "@/features/shell/content-routes";

type SectionRouter = ReturnType<typeof createMemoryRouter>;

export type SectionRouteSnapshot = {
  pathname: string;
  locationKey: string;
  action: NavigationType;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type SectionRouterJournal = {
  router: SectionRouter;
  getSnapshot: () => SectionRouteSnapshot;
  subscribe: (listener: () => void) => () => void;
  resetForTests: () => Promise<void>;
};

const routeChildren: Record<RendererShellSection, RouteObject[]> = {
  audio: [
    { index: true, element: <SectionRoutePage /> },
    { path: ":audioId", element: <SectionRoutePage /> },
    { path: ":audioId/capture/:sessionId", element: <SectionRoutePage /> },
  ],
  messages: [
    { index: true, element: <SectionRoutePage /> },
    { path: ":activityId", element: <SectionRoutePage /> },
    {
      path: ":activityId/capture/:sessionId",
      element: <SectionRoutePage />,
    },
  ],
  companion: [
    { index: true, element: <SectionRoutePage /> },
    { path: "pairing", element: <SectionRoutePage /> },
    { path: "history", element: <SectionRoutePage /> },
    { path: "device/:deviceId", element: <SectionRoutePage /> },
  ],
  settings: [
    { index: true, element: <SectionRoutePage /> },
    { path: ":categoryId", element: <SectionRoutePage /> },
  ],
};

export function createSectionRouterJournal(
  section: RendererShellSection,
): SectionRouterJournal {
  const router = createMemoryRouter(
    [
      {
        path: `/${section}`,
        element: <SectionRouteLayout />,
        children: routeChildren[section],
      },
    ],
    { initialEntries: [`/${section}`] },
  );
  let keys = [router.state.location.key];
  let index = 0;
  let snapshot = project();
  const listeners = new Set<() => void>();

  router.subscribe((state) => {
    const key = state.location.key;
    if (state.historyAction === "PUSH") {
      keys = [...keys.slice(0, index + 1), key];
      index = keys.length - 1;
    } else if (state.historyAction === "REPLACE") {
      keys[index] = key;
    } else {
      const target = keys.indexOf(key);
      if (target >= 0) index = target;
    }
    snapshot = project();
    for (const listener of listeners) listener();
  });

  function project(): SectionRouteSnapshot {
    return {
      pathname: router.state.location.pathname,
      locationKey: router.state.location.key,
      action: router.state.historyAction,
      canGoBack: index > 0,
      canGoForward: index < keys.length - 1,
    };
  }

  return {
    router,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resetForTests: async () => {
      await router.navigate(`/${section}`, { replace: true });
      keys = [router.state.location.key];
      index = 0;
      snapshot = project();
      for (const listener of listeners) listener();
    },
  };
}

export const sectionRouterRegistry: Record<
  RendererShellSection,
  SectionRouterJournal
> = {
  audio: createSectionRouterJournal("audio"),
  messages: createSectionRouterJournal("messages"),
  companion: createSectionRouterJournal("companion"),
  settings: createSectionRouterJournal("settings"),
};

export function SectionRouterProvider({
  section,
}: {
  section: RendererShellSection;
}) {
  return <RouterProvider router={sectionRouterRegistry[section].router} />;
}

export function useSectionRouteSnapshot(section: RendererShellSection) {
  const journal = sectionRouterRegistry[section];
  return React.useSyncExternalStore(
    journal.subscribe,
    journal.getSnapshot,
    journal.getSnapshot,
  );
}

export function navigateSection(
  section: RendererShellSection,
  pathname: string,
  options?: { replace?: boolean },
) {
  const journal = sectionRouterRegistry[section];
  if (journal.router.state.location.pathname === pathname) return;
  return journal.router.navigate(pathname, options);
}

export function navigateSectionDelta(
  section: RendererShellSection,
  delta: -1 | 1,
) {
  return sectionRouterRegistry[section].router.navigate(delta);
}

export async function resetSectionRoutersForTests() {
  await Promise.all(
    Object.values(sectionRouterRegistry).map((journal) =>
      journal.resetForTests(),
    ),
  );
}
