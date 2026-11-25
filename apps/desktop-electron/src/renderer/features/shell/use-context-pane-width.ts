import * as React from "react";

import {
  CONTEXT_PANE_WIDTH,
  SHELL_GEOMETRY,
} from "@/features/shell/context-pane-contract";

type ContextPaneWidthLimits = {
  minimum: number;
  maximum: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function contextPaneWidthLimits(
  viewportWidth: number,
): ContextPaneWidthLimits {
  const viewportMaximum =
    viewportWidth -
    SHELL_GEOMETRY.primaryRailWidth -
    SHELL_GEOMETRY.workspaceInset -
    2 * SHELL_GEOMETRY.workspaceBorderWidth -
    CONTEXT_PANE_WIDTH.mainContentMinimum;
  return {
    minimum: CONTEXT_PANE_WIDTH.minimum,
    maximum: Math.max(
      CONTEXT_PANE_WIDTH.minimum,
      Math.min(CONTEXT_PANE_WIDTH.maximum, viewportMaximum),
    ),
  };
}

export function resolveContextPaneWidth(
  requestedWidth: number,
  viewportWidth: number,
) {
  const limits = contextPaneWidthLimits(viewportWidth);
  return clamp(requestedWidth, limits.minimum, limits.maximum);
}

function normalizeRequestedWidth(width: number) {
  const finiteWidth = Number.isFinite(width)
    ? width
    : CONTEXT_PANE_WIDTH.default;
  return clamp(
    finiteWidth,
    CONTEXT_PANE_WIDTH.minimum,
    CONTEXT_PANE_WIDTH.maximum,
  );
}

export function useContextPaneWidth() {
  const [requestedWidth, setRequestedWidthState] = React.useState<number>(
    CONTEXT_PANE_WIDTH.default,
  );
  const [viewportWidth, setViewportWidth] = React.useState(
    () => window.innerWidth,
  );

  React.useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  const effectiveWidth = resolveContextPaneWidth(requestedWidth, viewportWidth);
  const setRequestedWidth = React.useCallback((width: number) => {
    setRequestedWidthState(normalizeRequestedWidth(width));
  }, []);
  return {
    requestedWidth,
    effectiveWidth,
    limits: contextPaneWidthLimits(viewportWidth),
    setRequestedWidth,
  };
}
