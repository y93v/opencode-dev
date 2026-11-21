export type ThemeKit = {
  id: string
  label: string
  family: "dark" | "light"
  tagline: string
  bg: string
  accent: string
}
// Stable IDs retain existing preferences. Themes never install screen overlays.
export const KITS: readonly ThemeKit[] = [
  { id: "aurora", label: "Aurora", family: "dark", tagline: "Quiet violet", bg: "#10101c", accent: "#b6a4ff" },
  { id: "graphite", label: "Graphite", family: "dark", tagline: "Made for focus", bg: "#141517", accent: "#d4d6dc" },
  { id: "ink", label: "Ink", family: "dark", tagline: "True black", bg: "#000000", accent: "#ffffff" },
  {
    id: "lagoon",
    label: "Lagoon",
    family: "dark",
    tagline: "Deep water, clear mind",
    bg: "#08191c",
    accent: "#69dfcf",
  },
  { id: "ember", label: "Ember", family: "dark", tagline: "A little warmth", bg: "#1b1310", accent: "#ffb182" },
  { id: "neon", label: "Neon", family: "dark", tagline: "After hours", bg: "#170e1e", accent: "#f6a2e1" },
  { id: "frost", label: "Frost", family: "dark", tagline: "Cool blue clarity", bg: "#101a28", accent: "#91d8fa" },
  { id: "obsidian", label: "Obsidian", family: "dark", tagline: "Soft charcoal", bg: "#101112", accent: "#ece5db" },
  { id: "phosphor", label: "Phosphor", family: "dark", tagline: "Terminal heritage", bg: "#0b160f", accent: "#91e9a3" },
  { id: "prism", label: "Prism", family: "dark", tagline: "Periwinkle precision", bg: "#141522", accent: "#acbaff" },
  { id: "vapor", label: "Vapor", family: "dark", tagline: "Peach at midnight", bg: "#201329", accent: "#ffb8a0" },
  { id: "midnight", label: "Midnight", family: "dark", tagline: "The late shift", bg: "#0c1525", accent: "#8fb8ff" },
  { id: "forest", label: "Forest", family: "dark", tagline: "Grounded greens", bg: "#111b16", accent: "#b0d998" },
  {
    id: "espresso",
    label: "Espresso",
    family: "dark",
    tagline: "Warm, rich, restrained",
    bg: "#211914",
    accent: "#dfbb8b",
  },
  { id: "oxblood", label: "Oxblood", family: "dark", tagline: "Burgundy and rose", bg: "#221318", accent: "#f0a7b8" },
  { id: "slate", label: "Slate", family: "dark", tagline: "Blue-grey balance", bg: "#182026", accent: "#a5d2dd" },
  { id: "paper", label: "Paper", family: "light", tagline: "A clean page", bg: "#fafafa", accent: "#34343d" },
  {
    id: "porcelain",
    label: "Porcelain",
    family: "light",
    tagline: "Warm minimalism",
    bg: "#f9f7f2",
    accent: "#645145",
  },
  { id: "sakura", label: "Sakura", family: "light", tagline: "Soft blossom", bg: "#fff5f8", accent: "#9c2955" },
  { id: "linen", label: "Linen", family: "light", tagline: "An editorial workspace", bg: "#f7f3e9", accent: "#70531c" },
  { id: "cloud", label: "Cloud", family: "light", tagline: "Daylight blue", bg: "#f3f7fe", accent: "#285cad" },
  { id: "mint", label: "Mint", family: "light", tagline: "Fresh perspective", bg: "#f0f9f4", accent: "#246345" },
  { id: "lavender", label: "Lavender", family: "light", tagline: "Gentle, not grey", bg: "#f7f3ff", accent: "#6644a0" },
  { id: "sand", label: "Sand", family: "light", tagline: "Sunlit terracotta", bg: "#fff5ec", accent: "#994321" },
  {
    id: "clear",
    label: "Clear",
    family: "dark",
    tagline: "Transparent glass",
    bg: "#0b1026",
    accent: "#7dd3fc",
  },
]
export const DEFAULT_THEME = "aurora"
export const STORAGE_KEY = "devcode:theme"
export function themeKit(id: string | null | undefined) {
  return KITS.find((kit) => kit.id === id) ?? KITS[0]!
}
function mix(a: string, b: string, amount: number) {
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(
        parseInt(a.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(b.slice(offset, offset + 2), 16) * amount,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}
export function palette(kit: ThemeKit): Record<string, string> {
  const light = kit.family === "light"
  if (kit.id === "clear") {
    // Glass kit: only panel backgrounds carry alpha; text stays solid. The
    // `transparent` base lets the wallpaper layer behind <body> show through,
    // and the matching block in devcode-brand.css paints the glass.
    return {
      "bg-seed": "#0c1220",
      "bg-base": "transparent",
      "bg-subtle": "rgba(12,18,32,0.10)",
      "bg-layer-01": "rgba(12,18,32,0.18)",
      "bg-layer-02": "rgba(12,18,32,0.26)",
      "bg-layer-03": "rgba(12,18,32,0.36)",
      accent: "#f4f4f5",
      "accent-hover": "#ffffff",
      "on-accent": "#07121b",
      "text-base": "#f0f6ff",
      "text-muted": "#b6c4e0",
      "text-faint": "#7d8db0",
      "border-base": "rgba(255,255,255,0.14)",
      "border-strong": "rgba(255,255,255,0.30)",
      danger: "#fb7185",
      warn: "#fcd34d",
      success: "#6ee7b7",
      "radius-sm": "10px",
      "radius-md": "18px",
    }
  }
  const text = light ? "#242530" : "#f1f2f6"
  const toward = light ? "#242530" : "#ffffff"
  return {
    "bg-base": kit.bg,
    "bg-subtle": mix(kit.bg, toward, 0.025),
    "bg-layer-01": mix(kit.bg, toward, 0.045),
    "bg-layer-02": mix(kit.bg, toward, 0.075),
    "bg-layer-03": mix(kit.bg, toward, 0.11),
    accent: kit.accent,
    "accent-hover": mix(kit.accent, light ? "#000000" : "#ffffff", 0.12),
    "on-accent": light ? "#ffffff" : "#111218",
    "text-base": text,
    "text-muted": mix(kit.bg, text, 0.76),
    "text-faint": mix(kit.bg, text, light ? 0.72 : 0.68),
    "border-base": mix(kit.bg, toward, 0.15),
    "border-strong": mix(kit.bg, toward, 0.3),
    danger: light ? "#ad2943" : "#ff9bac",
    warn: light ? "#75520b" : "#f1cc83",
    success: light ? "#22683d" : "#9bddb1",
    "radius-sm": "7px",
    "radius-md": "12px",
  }
}
