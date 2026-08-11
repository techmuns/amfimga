import { useState } from "react";
import { getInitialTheme, setTheme, type Theme } from "../lib/theme";

export function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>(() => getInitialTheme());
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setLocal(next);
  };
  return (
    <button className="theme-btn" onClick={flip} aria-label="Toggle theme">
      {theme === "dark" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
