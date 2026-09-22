// @vitest-environment jsdom

import * as React from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  contextPaneWidthLimits,
  resolveContextPaneWidth,
  useContextPaneWidth,
} from "../../../src/renderer/features/shell/use-context-pane-width";
import { PaneResizeHandle } from "../../../src/renderer/components/ui/pane-resize-handle";
import { AppShellFrame } from "../../../src/renderer/features/shell/app-shell-frame";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function firePointer(
  element: Element,
  type: string,
  values: Partial<
    Pick<PointerEvent, "pointerId" | "button" | "clientX" | "isPrimary">
  >,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  fireEvent(element, event);
}

describe("context pane width", () => {
  it.each([
    { viewportWidth: 880, maximum: 350 },
    { viewportWidth: 1280, maximum: 380 },
    { viewportWidth: 1600, maximum: 380 },
  ])(
    "derives the supported bounds at $viewportWidth px",
    ({ viewportWidth, maximum }) => {
      expect(contextPaneWidthLimits(viewportWidth)).toEqual({
        minimum: 260,
        maximum,
      });
      expect(resolveContextPaneWidth(320, viewportWidth)).toBe(320);
      expect(resolveContextPaneWidth(100, viewportWidth)).toBe(260);
      expect(resolveContextPaneWidth(900, viewportWidth)).toBe(maximum);
    },
  );

  it("keeps the requested width while a narrower viewport applies a temporary clamp", () => {
    setViewportWidth(1280);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useContextPaneWidth());

    expect(result.current.requestedWidth).toBe(320);
    expect(result.current.effectiveWidth).toBe(320);

    act(() => result.current.setRequestedWidth(380));
    expect(result.current.requestedWidth).toBe(380);
    expect(result.current.effectiveWidth).toBe(380);

    act(() => setViewportWidth(880));
    expect(result.current.requestedWidth).toBe(380);
    expect(result.current.effectiveWidth).toBe(350);

    act(() => setViewportWidth(1600));
    expect(result.current.requestedWidth).toBe(380);
    expect(result.current.effectiveWidth).toBe(380);
    expect(writes).not.toHaveBeenCalled();
  });

  it("shares one runtime width across page, collapse, and empty-state changes", () => {
    setViewportWidth(1280);
    let widthController: ReturnType<typeof useContextPaneWidth> | undefined;

    function Harness({ state }: { state: string }) {
      const width = useContextPaneWidth();
      widthController = width;
      return (
        <output data-state={state} data-testid="effective-width">
          {width.effectiveWidth}
        </output>
      );
    }

    const view = render(<Harness state="audio-open" />);
    act(() => widthController?.setRequestedWidth(380));
    expect(screen.getByTestId("effective-width")).toHaveTextContent("380");

    for (const state of [
      "messages-open",
      "companion-open",
      "settings-open",
      "settings-collapsed",
    ]) {
      view.rerender(<Harness state={state} />);
      expect(screen.getByTestId("effective-width")).toHaveTextContent("380");
    }
    view.rerender(<Harness state="audio-empty" />);
    expect(screen.getByTestId("effective-width")).toHaveTextContent("380");
    view.rerender(<Harness state="audio-open" />);
    expect(screen.getByTestId("effective-width")).toHaveTextContent("380");

    view.unmount();
    render(<Harness state="audio-open" />);
    expect(screen.getByTestId("effective-width")).toHaveTextContent("320");
  });
});

describe("pane resize handle", () => {
  function renderHandle(
    overrides: Partial<React.ComponentProps<typeof PaneResizeHandle>> = {},
  ) {
    const onResize = vi.fn();
    const onResizeStateChange = vi.fn();
    const view = render(
      <PaneResizeHandle
        aria-label="调整音频上下文面板宽度"
        value={320}
        minimum={260}
        maximum={380}
        onResize={onResize}
        onResizeStateChange={onResizeStateChange}
        cancellationKey="audio"
        {...overrides}
      />,
    );
    return { ...view, onResize, onResizeStateChange };
  }

  function installAnimationFrameQueue() {
    let nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    return {
      flush() {
        const pending = [...frames.entries()];
        frames.clear();
        for (const [, callback] of pending) callback(performance.now());
      },
      size() {
        return frames.size;
      },
    };
  }

  it("exposes adjustable separator semantics and clamps keyboard steps", () => {
    const { onResize, rerender } = renderHandle();
    const handle = screen.getByRole("separator", {
      name: "调整音频上下文面板宽度",
    });

    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", "260");
    expect(handle).toHaveAttribute("aria-valuemax", "380");
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    expect(handle.querySelectorAll("[data-pane-resize-hit-area]")).toHaveLength(
      2,
    );

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });
    expect(onResize.mock.calls).toEqual([[310], [330], [260], [380]]);

    rerender(
      <PaneResizeHandle
        aria-label="调整音频上下文面板宽度"
        value={260}
        minimum={260}
        maximum={380}
        onResize={onResize}
        cancellationKey="audio"
      />,
    );
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledTimes(4);

    fireEvent.click(handle);
    fireEvent.doubleClick(handle);
    expect(onResize).toHaveBeenCalledTimes(4);
  });

  it("coalesces captured primary-pointer moves and flushes the last move on release", () => {
    const frames = installAnimationFrameQueue();
    const { onResize, onResizeStateChange } = renderHandle();
    const handle = screen.getByRole("separator");
    const pointerTarget = handle.querySelector(
      '[data-pane-resize-hit-area="upper"]',
    )!;
    vi.spyOn(handle, "hasPointerCapture").mockReturnValue(true);
    const setPointerCapture = vi.spyOn(handle, "setPointerCapture");
    const releasePointerCapture = vi.spyOn(handle, "releasePointerCapture");

    firePointer(pointerTarget, "pointerdown", {
      pointerId: 7,
      button: 0,
      clientX: 350,
      isPrimary: true,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(onResizeStateChange).toHaveBeenLastCalledWith(true);
    expect(document.body.style.userSelect).toBe("none");

    firePointer(pointerTarget, "pointermove", {
      pointerId: 7,
      clientX: 390,
      isPrimary: true,
    });
    firePointer(pointerTarget, "pointermove", {
      pointerId: 7,
      clientX: 410,
      isPrimary: true,
    });
    expect(frames.size()).toBe(1);
    expect(onResize).not.toHaveBeenCalled();

    firePointer(pointerTarget, "pointerup", {
      pointerId: 7,
      clientX: 410,
      isPrimary: true,
    });
    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenLastCalledWith(380);
    expect(frames.size()).toBe(0);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onResizeStateChange).toHaveBeenLastCalledWith(false);
    expect(document.body.style.userSelect).toBe("");

    firePointer(handle, "pointermove", {
      pointerId: 7,
      clientX: 450,
      isPrimary: true,
    });
    frames.flush();
    expect(onResize).toHaveBeenCalledOnce();
  });

  it("ignores non-primary pointers and cancels queued movement for every abort boundary", () => {
    const frames = installAnimationFrameQueue();
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const onResize = vi.fn();
    const onResizeStateChange = vi.fn();
    const props: React.ComponentProps<typeof PaneResizeHandle> = {
      "aria-label": "调整上下文面板宽度",
      value: 320,
      minimum: 260,
      maximum: 380,
      onResize,
      onResizeStateChange,
      cancellationKey: "audio",
    };
    const view = render(<PaneResizeHandle {...props} />);
    const handle = screen.getByRole("separator");

    firePointer(handle, "pointerdown", {
      pointerId: 1,
      button: 0,
      clientX: 300,
      isPrimary: false,
    });
    firePointer(handle, "pointermove", {
      pointerId: 1,
      clientX: 400,
      isPrimary: false,
    });
    frames.flush();
    expect(onResize).not.toHaveBeenCalled();

    const cancelWith = (
      finish: () => void,
      nextProps: React.ComponentProps<typeof PaneResizeHandle> = props,
    ) => {
      firePointer(handle, "pointerdown", {
        pointerId: 2,
        button: 0,
        clientX: 300,
        isPrimary: true,
      });
      firePointer(handle, "pointermove", {
        pointerId: 2,
        clientX: 380,
        isPrimary: true,
      });
      expect(frames.size()).toBe(1);
      finish();
      view.rerender(<PaneResizeHandle {...nextProps} />);
      frames.flush();
      expect(onResize).not.toHaveBeenCalled();
      expect(document.body.style.userSelect).toBe("");
    };

    cancelWith(() => firePointer(handle, "pointercancel", { pointerId: 2 }));
    cancelWith(() => fireEvent.lostPointerCapture(handle));
    cancelWith(() => window.dispatchEvent(new Event("blur")));
    cancelWith(() => undefined, { ...props, cancellationKey: "settings" });
    cancelWith(() => undefined, { ...props, disabled: true });
    expect(onResizeStateChange.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
      [true],
      [false],
      [true],
      [false],
      [true],
      [false],
    ]);
    firePointer(handle, "pointerdown", {
      pointerId: 3,
      button: 0,
      clientX: 300,
      isPrimary: true,
    });
    expect(frames.size()).toBe(0);
    expect(onResizeStateChange).toHaveBeenCalledTimes(10);

    view.rerender(<PaneResizeHandle {...props} cancellationKey="companion" />);
    firePointer(handle, "pointerdown", {
      pointerId: 4,
      button: 0,
      clientX: 300,
      isPrimary: true,
    });
    firePointer(handle, "pointermove", {
      pointerId: 4,
      clientX: 420,
      isPrimary: true,
    });
    expect(frames.size()).toBe(1);
    view.unmount();
    expect(frames.size()).toBe(0);
    frames.flush();
    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("");
    const blurListenersAdded = addEventListener.mock.calls
      .filter(([type]) => type === "blur")
      .map(([, listener]) => listener);
    const blurListenersRemoved = removeEventListener.mock.calls
      .filter(([type]) => type === "blur")
      .map(([, listener]) => listener);
    expect(blurListenersAdded).toHaveLength(6);
    expect(blurListenersRemoved).toEqual(blurListenersAdded);
  });
});

describe("app shell pane resizing", () => {
  it("disables sidebar width transitions only while the resize gesture is active", () => {
    const onWidthChange = vi.fn();
    const onTogglePane = vi.fn();
    const view = render(
      <AppShellFrame
        section="audio"
        onNavigate={vi.fn()}
        unreadActivityCount={0}
        contextPane={{
          open: true,
          section: "audio",
          presentation: "docked",
          onRequestClose: vi.fn(),
          children: <span>音频列表</span>,
        }}
        contextPaneWidth={320}
        contextPaneResize={{
          minimum: 260,
          maximum: 380,
          onChange: onWidthChange,
        }}
        onTogglePane={onTogglePane}
        title="音频"
      >
        音频正文
      </AppShellFrame>,
    );
    const wrapper = view.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-wrapper"]',
    )!;
    const gap = view.container.querySelector('[data-slot="sidebar-gap"]');
    const container = view.container.querySelector(
      '[data-slot="sidebar-container"]',
    );
    const handle = screen.getByRole("separator");

    fireEvent.click(handle);
    fireEvent.doubleClick(handle);
    expect(onTogglePane).not.toHaveBeenCalled();
    expect(onWidthChange).not.toHaveBeenCalled();

    expect(gap).toHaveClass(
      "group-data-[resizing=true]/sidebar-wrapper:transition-none",
    );
    expect(container).toHaveClass(
      "group-data-[resizing=true]/sidebar-wrapper:transition-none",
    );
    firePointer(handle, "pointerdown", {
      pointerId: 8,
      button: 0,
      clientX: 350,
      isPrimary: true,
    });
    expect(wrapper).toHaveAttribute("data-resizing", "true");
    expect(document.body.style.userSelect).toBe("none");

    firePointer(handle, "pointercancel", { pointerId: 8 });
    expect(wrapper).not.toHaveAttribute("data-resizing");
    expect(document.body.style.userSelect).toBe("");
    expect(onWidthChange).not.toHaveBeenCalled();
  });
});
