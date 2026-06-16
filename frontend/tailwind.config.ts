import type { Config } from "tailwindcss";

/**
 * Token mapping. Tailwind classes resolve to CSS variables defined in
 * `globals.css`, so swapping `data-theme` on <html> instantly recolors
 * the entire UI without rebuilding.
 */
const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "var(--bg-base)",
          surface: "var(--bg-surface)",
          card: "var(--bg-card)",
          elevated: "var(--bg-elevated)",
          // Aliases the older code still uses — left pointing at sensible
          // surfaces so nothing breaks during the migration.
          secondary: "var(--bg-surface)",
        },
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        muted: "var(--text-muted)",
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          glow: "var(--accent-glow)",
          emerald: "var(--accent)",
          // Legacy aliases — point at the same emerald so any pre-rewrite
          // class using `accent-blue/cyan/violet` still renders in-palette
          // instead of throwing the design off.
          blue: "var(--accent)",
          cyan: "var(--accent)",
          violet: "var(--accent)",
          amber: "var(--warning)",
          red: "var(--critical)",
        },
        signal: {
          critical: "var(--critical)",
          warning: "var(--warning)",
          info: "var(--info)",
        },
        circuit: "var(--circuit)",
        "circuit-strong": "var(--circuit-strong)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "Geist",
          "Satoshi",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      boxShadow: {
        glow: "0 0 32px -6px var(--accent-glow)",
        glowSoft: "0 0 18px -2px var(--accent-glow)",
        glass: "0 8px 30px rgba(0,0,0,0.35)",
      },
      backgroundImage: {
        "hero-grad":
          "radial-gradient(120% 100% at 0% 0%, rgba(34,211,166,0.18) 0%, rgba(11,22,18,0) 60%), radial-gradient(120% 100% at 100% 100%, rgba(34,211,166,0.10) 0%, rgba(11,22,18,0) 60%)",
        "card-grad":
          "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 100%)",
      },
      keyframes: {
        shimmer: {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        pulseSoft: {
          "0%, 100%": { boxShadow: "0 0 0 0 var(--accent-glow)" },
          "50%": { boxShadow: "0 0 0 6px transparent" },
        },
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 3.2s ease-in-out infinite",
        pulseSoft: "pulseSoft 2.8s ease-out infinite",
        fadeIn: "fadeIn 280ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
