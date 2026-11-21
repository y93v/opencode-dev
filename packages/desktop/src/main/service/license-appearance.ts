import { KITS, palette, themeKit } from "../../../../app/src/devcode-themes"

function variables(id: string) {
  const p = palette(themeKit(id))
  return { bg: p["bg-base"], "bg-layer": p["bg-layer-01"], "bg-elev": p["bg-layer-02"], text: p["text-base"],
    muted: p["text-muted"], faint: p["text-faint"], accent: p.accent, "accent-hover": p["accent-hover"],
    "on-accent": p["on-accent"], border: p["border-base"], "border-strong": p["border-strong"],
    danger: p.danger, warn: p.warn, ok: p.success }
}
export function licenseBackground(id: string) {
  const bg = variables(id).bg!
  return bg === "transparent" ? "#00000000" : bg
}
export function licenseAppearance(id: string) {
  const declarations = Object.entries(variables(id)).map(([key, value]) => `--${key}:${value}`).join(";")
  return `<style id="license-palette">:root{${declarations};color-scheme:${themeKit(id).family}}</style><style>
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  body { padding:24px; }
  .card { width:100%; max-width:520px; margin:auto; padding:26px; background:var(--bg-layer); border:1px solid var(--border); border-radius:20px; box-shadow:0 14px 40px rgb(0 0 0 / .1); }
  .brand { display:flex; align-items:center; gap:9px; font-size:13px; font-weight:650; margin-bottom:26px; }
  .brand-mark { display:grid; place-items:center; width:30px; height:30px; border:1px solid var(--border-strong); border-radius:9px; color:var(--accent); }
  .eyebrow { margin-inline-start:auto; color:var(--muted); font-size:10px; font-weight:500; letter-spacing:.5px; }
  h1 { margin:0 0 8px; font-size:27px; letter-spacing:-.8px; line-height:1.2; font-weight:650; }
  p.sub { margin:0 0 24px; font-size:13px; line-height:1.6; color:var(--muted); }
  .card[data-status=active] .sub::before { content:""; display:inline-block; width:7px; height:7px; background:var(--ok); border-radius:50%; margin-inline-end:8px; }
  label { display:block; color:var(--muted); font-size:12px; font-weight:550; margin-bottom:8px; }
  input[type=text],input[type=email] { width:100%; padding:12px 13px; background:var(--bg); color:var(--text); border:1px solid var(--border-strong); border-radius:10px; font-family:inherit; font-size:14px; line-height:1.4; outline:none; }
  input[type=text] { font-family:ui-monospace,Consolas,monospace; letter-spacing:.04em; }
  input::placeholder { color:var(--faint); opacity:1; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent); }
  input.error { border-color:var(--danger); }
  .grid { display:grid; grid-template-columns:90px minmax(0,1fr); gap:0; margin:0 0 24px; border:1px solid var(--border); border-radius:12px; background:var(--bg); overflow:hidden; font-size:13px; align-items:stretch; }
  .grid dt,.grid dd { margin:0; padding:13px 15px; border-bottom:1px solid var(--border); display:flex; align-items:center; min-width:0; overflow-wrap:anywhere; }
  .grid dt { color:var(--muted); padding-inline-end:0; }
  .grid dd { color:var(--text); font-weight:550; }
  .grid dt:nth-last-child(2),.grid dd:last-child { border-bottom:0; }
  .grid dd.muted { color:var(--muted); font-size:12px; font-weight:400; }
  .days { display:inline-flex; align-items:baseline; gap:7px; }
  .days .n { font-size:28px; line-height:1; font-weight:650; letter-spacing:-1px; }
  .days .u { color:var(--muted); font-size:12px; }
  .days .warn { color:var(--warn); } .days .crit { color:var(--danger); }
  .row { display:flex; justify-content:flex-end; align-items:center; flex-wrap:wrap; gap:9px; margin-top:16px; }
  .remember { margin:0 auto 0 0; display:flex; gap:7px; align-items:center; font-size:12px; }
  .remember input { accent-color:var(--accent); width:16px; height:16px; }
  button { font-family:inherit; font-size:12px; font-weight:600; padding:11px 16px; border:1px solid var(--border-strong); border-radius:9px; cursor:pointer; background:var(--bg-elev); color:var(--text); }
  button.primary { background:var(--accent); color:var(--on-accent); border-color:transparent; }
  button.primary:hover { background:var(--accent-hover); }
  button.ghost { background:var(--bg); color:var(--text); }
  button.danger { margin-inline-end:auto; color:var(--danger); border-color:color-mix(in srgb,var(--danger) 40%,var(--border)); background:transparent; }
  button:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  button:disabled { cursor:wait; opacity:.65; }
  .status { margin-top:16px; min-height:18px; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
  .status.ok { color:var(--ok); } .status.err { color:var(--danger); }
  .inactive { padding:16px; background:var(--bg); color:var(--danger); border:1px solid var(--border); border-radius:12px; font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
  .buy { margin-top:22px; padding-top:18px; border-top:1px solid var(--border); font-size:12px; color:var(--muted); text-align:center; }
  .buy a { color:var(--accent); cursor:pointer; text-underline-offset:3px; }
  @media(max-width:400px) { body { padding:12px; } .card { padding:20px; border-radius:14px; } .eyebrow { display:none; } .grid { grid-template-columns:76px minmax(0,1fr); } button { padding:10px 12px; } }
  </style>`
}

// Known palette values only. A theme IPC event cannot inject CSS or markup.
export function licenseThemeListener() {
  const styles = Object.fromEntries(KITS.map((kit) => [kit.id, licenseAppearance(kit.id).split("</style>")[0]!.split('>')[1]]))
  return `require('electron').ipcRenderer.on('devcode:theme-changed', (_event, id) => {
    const styles = ${JSON.stringify(styles)};
    if (styles[id]) document.getElementById('license-palette').textContent = styles[id];
  });`
}
