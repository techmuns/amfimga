import {
  createContext, useCallback, useContext, useState, type ReactNode,
} from "react";

interface TooltipApi {
  show: (content: ReactNode, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  hide: () => void;
}

const Ctx = createContext<TooltipApi | null>(null);

export function useTooltip(): TooltipApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useTooltip must be used within <TooltipProvider>");
  return api;
}

/** A single floating tooltip shared by every chart and cell. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ content: ReactNode; x: number; y: number } | null>(null);

  const show = useCallback((content: ReactNode, x: number, y: number) => setState({ content, x, y }), []);
  const move = useCallback((x: number, y: number) => setState((s) => (s ? { ...s, x, y } : s)), []);
  const hide = useCallback(() => setState(null), []);

  // Keep the tooltip on-screen.
  const left = state ? Math.min(state.x + 14, window.innerWidth - 272) : 0;
  const top = state ? Math.min(state.y + 14, window.innerHeight - 120) : 0;

  return (
    <Ctx.Provider value={{ show, move, hide }}>
      {children}
      {state && (
        <div className="tooltip" style={{ left, top }}>
          {state.content}
        </div>
      )}
    </Ctx.Provider>
  );
}
