import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type * as OpenTui from "@opentui/core";

type DialogElement = ReturnType<TuiPluginApi["ui"]["DialogAlert"]>;
export type ValueViewer = (title: string, message: string) => DialogElement;
export type ValueViewerLoader = (api: TuiPluginApi) => Promise<ValueViewer>;

export function createValueViewer(
  api: TuiPluginApi,
  runtime: typeof OpenTui,
): ValueViewer {
  const {
    BoxRenderable,
    TextRenderable,
    ScrollBoxRenderable,
    RenderableEvents,
  } = runtime;
  return (title, message) => {
    if (api.lifecycle.signal.aborted) {
      throw new Error("The host is closed");
    }
    const { renderer } = api;
    const theme = api.theme.current;
    const height = () =>
      Math.max(1, renderer.height - Math.floor(renderer.height / 4) - 9);
    const view = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingX: 2,
      paddingBottom: 1,
      gap: 1,
    });
    view.add(
      new TextRenderable(renderer, {
        content: title,
        fg: theme.text,
        selectable: false,
      }),
    );
    const text = new TextRenderable(renderer, {
      content: message,
      fg: theme.text,
      wrapMode: "word",
    });
    const scroll = new ScrollBoxRenderable(renderer, {
      height: height(),
      flexShrink: 0,
    });
    scroll.add(text);
    view.add(scroll);
    view.add(
      new TextRenderable(renderer, {
        content: "↑/↓ scroll · pgup/pgdn page · home/end · esc back",
        fg: theme.textMuted,
        selectable: false,
      }),
    );
    const fit = () => {
      if (!scroll.isDestroyed) {
        scroll.height = height();
      }
    };
    renderer.on("resize", fit);
    const unbind = api.keymap.registerLayer({
      target: scroll,
      targetMode: "focus",
      bindings: [
        { key: "pageup", cmd: () => scroll.scrollBy(-1 / 2, "viewport") },
        { key: "pagedown", cmd: () => scroll.scrollBy(1 / 2, "viewport") },
        { key: "home", cmd: () => scroll.scrollBy(-1, "content") },
        { key: "end", cmd: () => scroll.scrollBy(1, "content") },
      ],
    });
    const focus = setTimeout(() => {
      if (!scroll.isDestroyed && !api.lifecycle.signal.aborted) {
        scroll.focus();
      }
    }, 1);
    const dispose = () => view.destroyRecursively();
    api.lifecycle.signal.addEventListener("abort", dispose, { once: true });
    view.on(RenderableEvents.DESTROYED, () => {
      clearTimeout(focus);
      renderer.off("resize", fit);
      unbind();
      api.lifecycle.signal.removeEventListener("abort", dispose);
    });
    // OpenTUI's reconciler accepts Renderable instances as JSX children.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The shared JSX type does not name Renderable instances.
    return view as unknown as DialogElement;
  };
}
