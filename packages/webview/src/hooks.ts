import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ToWebview } from "@delamain/core";
import { getState, onHostMessage, post, setState } from "./vscode";

/** useState backed by the webview state, so it survives the view being hidden and restored. */
export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stored = getState<T>(key);
    if (stored !== undefined) return stored;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    setState(key, value);
  }, [key, value]);
  return [value, setValue];
}

/** Subscribes to host messages, then announces the view is ready so the host replays its state. */
export function useHostConnection(view: "chat" | "config", handler: (message: ToWebview) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const unsubscribe = onHostMessage((message) => latest.current(message));
    post({ type: "ready", view });
    return unsubscribe;
  }, [view]);
}

/** Keeps a ref in sync with the latest value, for message handlers registered once. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useToggleSet(): [ReadonlySet<string>, (id: string) => void] {
  const [set, setSet] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((id: string) => {
    setSet((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return [set, toggle];
}
