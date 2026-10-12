#!/usr/bin/env node
/**
 * Turns measurements taken off Figma into Lumos tokens.
 *
 * Figma cannot express three things this system relies on, so every value
 * arrives in a form that has to be converted back:
 *
 *   rem          Figma is px-only. Divide by 16.
 *   letter-      Figma is px or %, this system is em. px divided by the font
 *   spacing      size, or % divided by 100 — both give em.
 *   color-mix    Figma has no mixing, so designers restate the same hex at
 *                a lower opacity. Alpha becomes the mix percentage.
 *
 * Responsive tokens (space, radius, icon, type size, line height) hold three
 * px values, one per breakpoint: mobile (below 768px), tablet (768-991px) and
 * desktop (992px and up). Line height is px per breakpoint, not a ratio.
 * A value measured at every breakpoint is taken as given. A breakpoint that was
 * not measured is derived from the ratios of the closest existing token and
 * reported as a guess.
 *
 * Reports only. Placing tokens in the right section of base.css is a judgement
 * call about what a value means, so it stays with whoever is reading the design.
 *
 * Usage
 *   node convert.mjs --variables Responsive.json Static.json [--css path/to/base.css] [--astro-config path]
 *   node convert.mjs --design-context about-desktop.txt about-tablet.txt
 *   node convert.mjs --summary about-desktop.txt
 *   node convert.mjs --folder [figma] [--page home]
 *   node convert.mjs --json design.json [--css path/to/base.css]
 *   node convert.mjs --px 30 [--bp tablet|mobile]
 *   node convert.mjs --lh 36/32 [--bp tablet|mobile]
 *   node convert.mjs --color "#FFFFFF@60"
 *   node convert.mjs --metadata fixtures/sample-page.xml [--wrapper nodeId,...]
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/* Moves independently of the framework: a skill fix does not need a release,
   and a release does not invalidate the skill. */
const SKILL_VERSION = "2.6.0";
/* A pin, not a mirror: the release this skill was last checked against.
   Deriving it from package.json would make it always equal to the running
   version, and the mismatch note would never fire. */
const TESTED_AGAINST = "0.0.4";

const ROOT_PX = 16;
const SNAP_PX = 2; // ±2px counts as drift, not a decision
const SNAP_LH = 0.05;
const BPS = ["desktop", "tablet", "mobile"];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
/** Every argument after the flag, up to the next flag. */
const flagAll = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return [];
  const rest = args.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const cssPath = flag("css") ?? "src/styles/base.css";

/* ---------- read what the system already has ---------- */

function readTokens(css) {
  /* A responsive token is --NAME-mobile / -tablet / -desktop, unitless px. */
  const scale = {};
  for (const m of css.matchAll(/--([a-z0-9-]+)-mobile:\s*([\d.]+)/g)) {
    const name = m[1];
    if (name === "bp") continue;
    const tablet = css.match(new RegExp(`--${name}-tablet:\\s*([\\d.]+)`));
    const desktop = css.match(new RegExp(`--${name}-desktop:\\s*([\\d.]+)`));
    if (!tablet || !desktop) continue;
    scale[name] = { desktop: Number(desktop[1]), tablet: Number(tablet[1]), mobile: Number(m[2]) };
  }

  const lineHeights = {};
  for (const m of css.matchAll(/--line-height-([a-z0-9-]+):\s*([\d.]+)\s*;/g)) {
    lineHeights[`--line-height-${m[1]}`] = Number(m[2]);
  }

  const letterSpacing = {};
  for (const m of css.matchAll(/--letter-spacing-([a-z0-9-]+):\s*(-?[\d.]+)em/g)) {
    letterSpacing[`--letter-spacing-${m[1]}`] = Number(m[2]);
  }

  const weights = {};
  for (const m of css.matchAll(/--primary-([a-z]+):\s*(\d+)\s*;/g)) {
    weights[`--primary-${m[1]}`] = Number(m[2]);
  }

  const swatches = {};
  for (const m of css.matchAll(/--(color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    swatches[`--${m[1]}`] = m[2].toLowerCase();
  }

  /* Swatches that some theme uses as --text. A muted version of one of these
     is nearly always currentcolor in this system, not a fixed colour. */
  const textSwatches = new Set();
  for (const m of css.matchAll(/--text:\s*var\((--[a-z0-9-]+)\)/g)) textSwatches.add(m[1]);

  /* What each style's --X-letter-spacing resolves to, through the --letter-spacing-* tokens. */
  const styleLetter = {};
  for (const m of css.matchAll(/--([a-z0-9-]+)-letter-spacing:\s*(?:var\((--letter-spacing-[a-z0-9-]+)\)|(-?[\d.]+)em)/g)) {
    styleLetter[m[1]] = { token: m[2] ?? null, em: m[2] ? letterSpacing[m[2]] : Number(m[3]) };
  }

  const styleWeight = {};
  for (const m of css.matchAll(/--([a-z0-9-]+)-font-weight:\s*(?:var\((--primary-[a-z]+)\)|(\d+))/g)) {
    styleWeight[m[1]] = { token: m[2] ?? null, value: m[2] ? weights[m[2]] : Number(m[3]) };
  }

  const styleTransform = {};
  for (const m of css.matchAll(/--([a-z0-9-]+)-text-transform:\s*([a-z]+)/g)) styleTransform[m[1]] = m[2];

  /* :root and the light theme block, so --heading → --text → --color-* can be followed. */
  const rootVars = {};
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) rootVars[m[1]] ??= m[2].trim();
  const light = css.match(/(?:^|\n)(:root,[^{]*)\{([^}]*color-scheme:\s*light[^}]*)\}/);
  const themeLight = Object.fromEntries([...(light?.[2] ?? "").matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

  return { scale, lineHeights, letterSpacing, styleLetter, styleWeight, styleTransform, weights, swatches, textSwatches, rootVars, themeLight };
}

/** The families under `fonts:` in astro.config.mjs: provider, weights covered, and any pinned variable axes. */
function readFonts(text) {
  const start = text.search(/\bfonts:\s*\[/);
  if (start === -1) return null;
  let depth = 0;
  let end = text.length;
  for (let i = text.indexOf("[", start); i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]" && --depth === 0) {
      end = i;
      break;
    }
  }
  /* "400", 400, "bold" or "400 700" (a range): the top-level `weights` array, or a local variant's `weight`. */
  const weightRange = (item) => {
    const text = item.replace(/["']/g, "").trim();
    if (/^\d+\s+\d+$/.test(text)) return text.split(/\s+/).map(Number);
    const n = /^\d+$/.test(text) ? Number(text) : WEIGHT_NAMES[text.toLowerCase().replace(/[^a-z]/g, "")];
    return n ? [n, n] : null;
  };
  return text
    .slice(start, end)
    .split(/(?=\bname:\s*["'])/)
    .slice(1)
    .map((seg) => {
      const ranges = [...seg.matchAll(/\bweights?:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|\w+)/g)]
        .flatMap((m) => m[1].startsWith("[") ? m[1].match(/"[^"]*"|'[^']*'|\w+/g) : [m[1]])
        .map(weightRange)
        .filter(Boolean);
      const opsz = seg.match(/\bopsz:\s*\[([^\]]*)\]/)?.[1].match(/[\d.]+/g) ?? [];
      return {
        name: seg.match(/name:\s*["']([^"']+)["']/)[1],
        cssVariable: seg.match(/cssVariable:\s*["']([^"']+)["']/)?.[1],
        provider: seg.match(/fontProviders\.(\w+)/)?.[1] ?? "unknown",
        ranges,
        opsz,
      };
    });
}

/** The configured font a Figma family resolves to. "Inter Display" is Inter pinned at optical size 32. */
function fontFor(fonts, family) {
  const key = family.toLowerCase();
  const exact = fonts.find((f) => f.name.toLowerCase() === key);
  if (exact) return { font: exact, note: null };
  if (key !== "inter display") return { font: null, note: null };
  const inter = fonts.find((f) => f.name.toLowerCase() === "inter");
  if (inter?.opsz.length === 1 && inter.opsz[0] === "32") return { font: inter, note: "Inter Display = Inter pinned at opsz 32" };
  return { font: null, note: 'Inter Display is Inter at optical size 32: pin it with options.experimental.variableAxis: { opsz: ["32"] } on the Inter entry, or add the font file' };
}

/* ---------- conversions ---------- */

const toRem = (px) => +(px / ROOT_PX).toFixed(4);
const unitless = (lhPx, sizePx) => +(lhPx / sizePx).toFixed(3);

/* On a tie, prefer the general scale over layout-specific tokens: 30px should
   land on --space-2rem, not --site-gutter, even though both are 32 at desktop. */
const rank = (name) =>
  name.startsWith("space") ? 0 : name.startsWith("section-space") ? 1 : 2;

const isSpace = (n) => n.startsWith("space-") || n.startsWith("section-space") || n.startsWith("site-");
const isRadius = (n) => n.startsWith("radius-");
const isIcon = (n) => n.startsWith("icon-");
const isLineHeight = (n) => n.endsWith("-line-height");
const isType = (n) => /^(display|h[1-6]|text-(large|main|small|xsmall)|overline-(small|main))$/.test(n);

/** A bare number is a desktop measurement; an object names the breakpoints it measured. */
function perBp(value, label) {
  if (typeof value === "number") return { desktop: value };
  const keys = value && typeof value === "object" ? Object.keys(value) : [];
  const bad = keys.filter((k) => !BPS.includes(k) || typeof value[k] !== "number");
  if (!keys.length || bad.length) {
    fail(`${label}: expected a number (desktop) or { ${BPS.join(", ")} } numbers, got ${JSON.stringify(value)}${bad.length ? ` — bad: ${bad.join(", ")}` : ""}`);
  }
  return value;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** "D54 T45 M32", for whichever breakpoints are present. */
const fmt = (values) =>
  BPS.filter((bp) => values[bp] !== undefined).map((bp) => `${bp[0].toUpperCase()}${values[bp]}`).join(" ");

/** Closest token across the breakpoints measured: lowest total distance, then the general scale. */
function nearest(values, scale, kindFilter) {
  const ranked = Object.entries(scale)
    .filter(([name]) => !kindFilter || kindFilter(name))
    .map(([name, v]) => {
      const deltas = Object.keys(values).map((bp) => Math.abs(v[bp] - values[bp]));
      return { name, cost: deltas.reduce((a, b) => a + b, 0), delta: Math.max(...deltas), ...v };
    })
    .sort((a, b) => a.cost - b.cost || rank(a.name) - rank(b.name));
  if (!ranked.length) return null;
  const ties = ranked.slice(1).filter((r) => r.cost === ranked[0].cost).map((r) => r.name);
  return { ...ranked[0], ties };
}

/** Only worth saying when the match is not exact. */
const tieNote = (near) =>
  near?.delta && near.ties.length ? `equally close: ${near.ties.map((t) => `--${t}`).join(", ")}` : "";

/** Fills the breakpoints that were not measured from the closest token's ratios. */
function deriveMissing(values, scale, kindFilter) {
  const have = BPS.filter((bp) => values[bp] !== undefined);
  const missing = BPS.filter((bp) => values[bp] === undefined);
  const ref = nearest(values, scale, kindFilter);
  if (!missing.length || !ref) return { values, missing, ref: ref?.name ?? null, ratios: [] };
  /* Scale from the measured breakpoint nearest the missing one. */
  const baseFor = (bp) => have.reduce((a, b) => (Math.abs(BPS.indexOf(b) - BPS.indexOf(bp)) < Math.abs(BPS.indexOf(a) - BPS.indexOf(bp)) ? b : a));
  const ratio = (bp) => (ref[baseFor(bp)] ? ref[bp] / ref[baseFor(bp)] : 1);
  const out = { ...values };
  for (const bp of missing) out[bp] = Math.round(values[baseFor(bp)] * ratio(bp));
  return { values: out, missing, ref: ref.name, ratios: missing.map((bp) => `${bp} ×${ratio(bp).toFixed(3)} of ${baseFor(bp)}`) };
}

function nearestValue(value, table) {
  let best = null;
  for (const [name, v] of Object.entries(table)) {
    const delta = Math.abs(v - value);
    if (!best || delta < best.delta) best = { name, value: v, delta };
  }
  return best;
}

/* Figma names weights, CSS numbers them. */
const WEIGHT_NAMES = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400,
  normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600,
  bold: 700, extrabold: 800, black: 900, heavy: 900,
};

const hexToRgb = (hex) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

function nearestSwatch(hex, swatches) {
  const [r, g, b] = hexToRgb(hex);
  let best = null;
  for (const [name, value] of Object.entries(swatches)) {
    const [r2, g2, b2] = hexToRgb(value);
    const d = Math.hypot(r - r2, g - g2, b - b2);
    if (!best || d < best.d) best = { name, value, d: +d.toFixed(1) };
  }
  return best;
}

/* WCAG 2.1 relative luminance and contrast. Flagged, never blocking: a
   decorative label may fail on purpose, and that is the designer's call. */
const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** Alpha is opacity over a background, so flatten before measuring. */
const composite = (fg, bg, alpha) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

function contrastRatio(fgHex, bgHex, alpha = 1) {
  const bg = hexToRgb(bgHex);
  const fg = composite(hexToRgb(fgHex), bg, alpha);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

/** 24px, or 18.66px when bold, is "large text" and gets the lower bar. */
const contrastFloor = (sizePx, bold) =>
  sizePx >= 24 || (bold && sizePx >= 18.66) ? 3 : 4.5;

/** Alpha in Figma is a stand-in for a mix, so restate it as one. */
function toColorMix(hex, alphaPct, swatches) {
  const match = nearestSwatch(hex, swatches);
  const base = match && match.d === 0 ? `var(${match.name})` : hex.toLowerCase();
  if (alphaPct >= 100) return { css: base, match };
  return { css: `color-mix(in lab, ${base} ${alphaPct}%, transparent)`, match };
}

/** The exact shape base.css uses for a responsive token, so a generated one matches by hand. */
const responsive = (n, v) => [
  `--${n}: calc((var(--bp-mobile) * var(--${n}-mobile) + var(--bp-tablet) * var(--${n}-tablet) + var(--bp-desktop) * var(--${n}-desktop)) / 16 * 1rem);`,
  `--${n}-mobile: ${v.mobile};`,
  `--${n}-tablet: ${v.tablet};`,
  `--${n}-desktop: ${v.desktop};`,
];

/** Just the three values, for a token that already exists and only changes. */
const triple = (n, v) => responsive(n, v).slice(1);

/* ---------- one-off lookups ---------- */

const css = readFileSync(cssPath, "utf8");
const tokens = readTokens(css);
/* utilities.css beside base.css: which .weight-* classes the project already has for minority weights. */
const utilitiesCss = (() => {
  try {
    return readFileSync(join(cssPath, "..", "utilities.css"), "utf8");
  } catch {
    return "";
  }
})();
const hasWeightUtility = (w) => Boolean(WEIGHT_UTILITY[w]) && new RegExp(`^\\.weight-${WEIGHT_UTILITY[w]}\\s*\\{`, "m").test(utilitiesCss);
/** A style used with several weights needs no question when base.css already holds one of them and a .weight-* utility exists for every other. */
const weightsCovered = (def, seen) => def !== undefined && seen.includes(def) && seen.every((w) => w === def || hasWeightUtility(w));

const bp = flag("bp") ?? "desktop";
if (!BPS.includes(bp)) fail(`--bp must be one of: ${BPS.join(", ")}`);

if (flag("px") !== undefined) {
  const px = Number(flag("px"));
  const near = nearest({ [bp]: px }, tokens.scale, isSpace);
  console.log(`${px}px = ${toRem(px)}rem  (${bp})`);
  if (near) {
    const verdict = near.delta <= SNAP_PX ? `SNAP to --${near.name}` : `no token within ${SNAP_PX}px`;
    const tie = tieNote(near) && `; ${tieNote(near)}`;
    console.log(`nearest at ${bp}: --${near.name} (${fmt(near)}), off by ${near.delta}px — ${verdict}${tie}`);
  }
  process.exit(0);
}

if (flag("lh")) {
  const [lh, size] = flag("lh").split("/").map(Number);
  const near = nearest({ [bp]: lh }, tokens.scale, isLineHeight);
  console.log(`line height ${lh}px  (${bp})`);
  if (near) {
    const verdict = near.delta <= SNAP_PX ? `SNAP to --${near.name}` : `no token within ${SNAP_PX}px`;
    const tie = tieNote(near) && `; ${tieNote(near)}`;
    console.log(`nearest at ${bp}: --${near.name} (${fmt(near)}), off by ${near.delta}px — ${verdict}${tie}`);
  }
  if (size) {
    /* The --line-height-* ratios only serve display and ad-hoc use. */
    const ratio = unitless(lh, size);
    const ratioNear = nearestValue(ratio, tokens.lineHeights);
    const verdict = ratioNear.delta <= SNAP_LH ? "SNAP" : "no ratio close enough";
    console.log(`${lh}px / ${size}px = ${ratio}; nearest ratio ${ratioNear.name} (${ratioNear.value}), off by ${ratioNear.delta.toFixed(3)} — ${verdict}`);
  }
  process.exit(0);
}

if (flag("ls")) {
  /* --ls 2/64 (px over size) or --ls 3% */
  const raw = flag("ls");
  const em = raw.endsWith("%")
    ? +(Number(raw.slice(0, -1)) / 100).toFixed(4)
    : (() => { const [px, size] = raw.split("/").map(Number); return +(px / size).toFixed(4); })();
  const near = nearestValue(em, tokens.letterSpacing);
  console.log(`${raw} = ${em}em`);
  if (near) {
    const verdict = near.delta <= 0.005 ? `SNAP to ${near.name}` : "no token close enough";
    console.log(`nearest: ${near.name} (${near.value}em), off by ${near.delta.toFixed(4)} — ${verdict}`);
  }
  process.exit(0);
}

if (flag("color")) {
  const [hex, pct] = flag("color").split("@");
  const alpha = pct === undefined ? 100 : Number(pct);
  const { css: out, match } = toColorMix(hex, alpha, tokens.swatches);
  console.log(out);
  if (match) console.log(`nearest swatch: ${match.name} (${match.value}), distance ${match.d}`);
  process.exit(0);
}

/* ---------- shared report pieces ---------- */

/** One block per new token: responsive ones in the 4-line shape, the rest as one line. */
const printBlock = (a) => {
  if (a.values) for (const l of responsive(a.name, a.values)) console.log(`  ${l}`);
  else console.log(`  --${a.name}: ${a.value};`);
};

const printTable = (head, body) => {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const row = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
  console.log(row(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of body) console.log(row(r));
};

let lumosVersion = "unknown";
try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  lumosVersion = pkg.lumos?.version ?? pkg.version;
} catch {}
const printVersion = () => {
  console.log(`lumos-import-figma ${SKILL_VERSION}  ·  Lumos ${lumosVersion}`);
  const feature = (v) => v.split(".").slice(0, 2).join(".");
  if (lumosVersion !== "unknown" && feature(lumosVersion) !== feature(TESTED_AGAINST)) {
    console.log(`  note: written against Lumos ${TESTED_AGAINST}; check base.css still matches (patch releases are fine).`);
  }
  console.log("");
};

/** The tokens that describe the page layout rather than a component. */
const isLayoutToken = (t) => /^(site-margin|site-gutter|display|section-space-[a-z0-9-]+)$/.test(t);
const layoutFamily = (token) => (n) =>
  token.startsWith("section-space-") ? n.startsWith("section-space-") : token.startsWith("site-") ? n.startsWith("site-") : n === token;

/** Whether the measured breakpoints already equal the token's own. */
function compareLayout(token, have) {
  const cur = tokens.scale[token];
  if (!cur) return { status: "UNMAPPED", cur: null };
  const equal = BPS.every((b) => have[b] === undefined || Math.abs(have[b] - cur[b]) < 0.01);
  return { status: equal ? "MATCH" : "DIFFERS", cur };
}

const LETTER_EPS = 0.002; // ±0.002em counts as the same letter spacing
/** What the variable export said about each token, for the checks that come after it. */
const varStatus = new Map();
const INVENTORY_KEYS = ["space", "type", "color", "letter", "radius", "icon", "layout", "weight"];

/* ---------- Figma variable export ---------- */

const BODY = { lg: "text-large", md: "text-main", sm: "text-small", xs: "text-xsmall" };
const OVERLINE = { sm: "overline-small", md: "overline-main" };

/** Figma variable name to the Lumos token it should be, or null for a group this skill does not know. */
function tokenFor(name) {
  const path = name
    .replace(/\s*\[[^\]]*\]$/, "")
    .split("/")
    .map((s) => s.toLowerCase().replace(/[_\s]+/g, "-"));
  const [a, b, c] = path;
  if (a === "font-size" || a === "line-height") {
    const base = b === "heading" && /^h[1-6]$/.test(c) ? c : b === "body" ? BODY[c] : b === "overline" ? OVERLINE[c] : null;
    if (!base) return null;
    return { token: a === "font-size" ? base : `${base}-line-height`, kind: "scale" };
  }
  if (a === "padding" || a === "spacing") return b ? { token: `space-${b}`, kind: "scale" } : null;
  if (a === "corner-radius") return b ? { token: `radius-${b}`, kind: "scale" } : null;
  if (a === "icon-size") return b ? { token: `icon-${b}`, kind: "scale" } : null;
  if (a === "color") return path.length > 2 ? { token: `color-${path.slice(1).join("-")}`, kind: "color" } : null;
  if (a === "font" && b === "weight" && c) return { token: `primary-${c.replace(/-/g, "")}`, kind: "weight" };
  if (a === "font" && b === "family" && c) return { token: "primary-family", kind: "family" };
  return null;
}

function runVariables(variableFiles) {
  /* Mode ids differ between files, so modes are told apart by name. */
  const modeBp = (name) => {
    const n = name.toLowerCase();
    if (/^de[sk]+top$/.test(n)) return "desktop"; // tolerates the "dekstop" typo
    return BPS.includes(n) ? n : null;
  };

  const resolved = (v, id) => v.resolvedValuesByMode?.[id]?.resolvedValue ?? v.valuesByMode[id];
  const toHex = ({ r, g, b }) =>
    `#${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;

  const entries = new Map();
  const unknownVars = [];
  for (const file of variableFiles) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data.modes || !Array.isArray(data.variables)) {
      fail(`${file}: not a Figma variable export — expected { name, modes, variables }`);
    }
    const modeBps = Object.entries(data.modes).map(([id, name]) => [id, modeBp(name)]);
    const byBreakpoint = modeBps.some(([, b]) => b);
    for (const v of data.variables) {
      const hit = tokenFor(v.name);
      if (!hit) {
        unknownVars.push(`${v.name} (${file})`);
        continue;
      }
      const values = {};
      if (byBreakpoint) {
        for (const [id, b] of modeBps) if (b) values[b] = resolved(v, id);
      } else {
        for (const b of BPS) values[b] = resolved(v, modeBps[0][0]);
      }
      const key = hit.kind === "family" ? v.name : hit.token;
      const prior = entries.get(key);
      if (!prior) {
        entries.set(key, { ...hit, sources: [v.name], values, conflict: false });
        continue;
      }
      prior.sources.push(v.name);
      for (const b of BPS) {
        if (prior.values[b] !== undefined && values[b] !== undefined && prior.values[b] !== values[b]) prior.conflict = true;
        prior.values[b] ??= values[b];
      }
    }
  }

  const familyOf = (token) => [isLineHeight, isType, isRadius, isIcon, isSpace].find((f) => f(token));
  const table = [];
  const toPlace = [];
  const toUpdate = [];
  const guesses = [];
  const asks = [];
  const counts = { match: 0, differs: 0, missing: 0 };
  const weightNeeds = [];
  const astroPath = flag("astro-config") ?? "astro.config.mjs";
  let fonts = null;
  try {
    fonts = readFonts(readFileSync(astroPath, "utf8"));
  } catch {}
  const primaryVar = css.match(/--primary-family:\s*var\((--[a-z0-9-]+)/)?.[1];
  const primaryFont = fonts?.find((f) => f.cssVariable === primaryVar);

  for (const e of entries.values()) {
    const from = e.sources.join(" + ");
    if (e.kind === "family") {
      const family = String(e.values.desktop);
      const { font: hit } = fonts ? fontFor(fonts, family) : {};
      const status = !fonts ? "not checked" : hit ? "configured" : "NOT CONFIGURED";
      table.push([from, "--primary-family", family, primaryFont ? `${primaryFont.name} (${primaryVar})` : primaryVar ?? "—", status]);
      if (hit) counts.match++;
      else if (fonts) counts.missing++;
    } else if (e.kind === "scale") {
      const have = Object.fromEntries(BPS.filter((b) => e.values[b] !== undefined).map((b) => [b, e.values[b]]));
      const token = tokens.scale[e.token];
      if (e.conflict) {
        varStatus.set(e.token, "differs");
        table.push([from, `--${e.token}`, fmt(have), token ? fmt(token) : "—", "CONFLICT"]);
        counts.differs++;
        asks.push(`${from} disagree in some mode. Which is right for --${e.token}?`);
      } else if (!token) {
        varStatus.set(e.token, "missing");
        const d = deriveMissing(have, tokens.scale, familyOf(e.token));
        table.push([from, `--${e.token}`, fmt(have), "—", d.missing.length ? `MISSING (${d.missing.join("/")} guessed)` : "MISSING"]);
        counts.missing++;
        toPlace.push({ name: e.token, values: d.values });
        if (d.missing.length) guesses.push(`--${e.token}: ${d.missing.join(", ")} guessed from --${d.ref} (${d.ratios.join(", ")}).`);
      } else if (BPS.every((b) => have[b] === undefined || have[b] === token[b])) {
        varStatus.set(e.token, "match");
        table.push([from, `--${e.token}`, fmt(have), fmt(token), "match"]);
        counts.match++;
      } else {
        varStatus.set(e.token, "differs");
        table.push([from, `--${e.token}`, fmt(have), fmt(token), "DIFFERS"]);
        counts.differs++;
        toUpdate.push({ name: e.token, values: { ...token, ...have } });
      }
    } else if (e.kind === "color") {
      const hex = toHex(e.values.desktop);
      const lumos = tokens.swatches[`--${e.token}`];
      if (!lumos) {
        table.push([from, `--${e.token}`, hex, "—", "MISSING"]);
        counts.missing++;
        toPlace.push({ name: e.token, value: hex });
      } else if (lumos === hex) {
        table.push([from, `--${e.token}`, hex, lumos, "match"]);
        counts.match++;
      } else {
        table.push([from, `--${e.token}`, hex, lumos, "DIFFERS"]);
        counts.differs++;
        toUpdate.push({ name: e.token, value: hex });
      }
    } else {
      const raw = e.values.desktop;
      const num = WEIGHT_NAMES[String(raw).toLowerCase().replace(/[^a-z]/g, "")];
      if (num) weightNeeds.push({ raw, num });
      const lumos = tokens.weights[`--${e.token}`];
      if (!num) {
        table.push([from, `--${e.token}`, String(raw), "—", "UNKNOWN weight name"]);
        counts.missing++;
      } else if (lumos === undefined) {
        table.push([from, `--${e.token}`, `${raw} (${num})`, "—", "MISSING"]);
        counts.missing++;
        toPlace.push({ name: e.token, value: String(num) });
      } else if (lumos === num) {
        table.push([from, `--${e.token}`, `${raw} (${num})`, String(lumos), "match"]);
        counts.match++;
      } else {
        table.push([from, `--${e.token}`, `${raw} (${num})`, String(lumos), "DIFFERS"]);
        counts.differs++;
        toUpdate.push({ name: e.token, value: String(num) });
      }
    }
  }

  const fontNotes = [];
  if (!fonts) {
    fontNotes.push(`${astroPath} not found or has no fonts: entry — fonts not checked.`);
  } else {
    const rendered = primaryFont ?? fonts[0];
    const wanted = new Map();
    for (const e of entries.values()) {
      if (e.kind !== "family") continue;
      const family = String(e.values.desktop);
      wanted.set(family, [...(wanted.get(family) ?? []), ...e.sources]);
    }
    for (const [family, sources] of wanted) {
      const { font: hit, note } = fontFor(fonts, family);
      fontNotes.push(`${family} (${sources.join(", ")}): ${hit ? `configured as ${hit.name} (${hit.cssVariable}, ${hit.provider})${note ? ` — ${note}` : ""}` : `NOT CONFIGURED — ${astroPath} has: ${fonts.map((f) => f.name).join(", ") || "nothing"}${note ? `. ${note}` : ""}`}`);
    }
    fontNotes.push(`--primary-family uses ${primaryVar ?? "no font variable"}${primaryFont ? `, which is ${primaryFont.name}` : ", which matches no entry"}.`);
    for (const w of new Map(weightNeeds.map((x) => [x.num, x])).values()) {
      const has = rendered?.ranges.some(([lo, hi]) => w.num >= lo && w.num <= hi);
      fontNotes.push(`weight ${w.raw} (${w.num}): ${has ? "covered by weights/variants" : "MISSING"} in ${rendered?.name ?? "—"}`);
    }
    if (fontNotes.some((n) => /NOT CONFIGURED|MISSING/.test(n))) {
      asks.push("Fonts are not fully configured. Add the missing weights (a local variant under src/assets/fonts, or widen `weights` on a fontProviders.google() entry where the family exists on Google Fonts)? That is the user's call.");
    }
  }

  console.log("D = desktop (>=992px), T = tablet (768-991px), M = mobile (<768px)\n");
  printTable(["FIGMA VARIABLE", "LUMOS TOKEN", "FIGMA", "LUMOS", "STATUS"], table);
  console.log(`\n${counts.match} match, ${counts.differs} differ, ${counts.missing} missing, ${unknownVars.length} unknown group`);
  console.log("Letter spacing and text-transform are not in a variable export — read them off the text nodes and pass letterPx / letterPct on each type entry.");

  console.log("\nFONTS (astro.config.mjs and --primary-family):");
  for (const n of fontNotes) console.log(`  - ${n}`);

  if (unknownVars.length) {
    console.log("\nUNKNOWN VARIABLE GROUPS (not converted):");
    for (const n of unknownVars) console.log(`  - ${n}`);
  }
  out.asks.push(...asks);
  out.guesses.push(...guesses);
  for (const u of toUpdate) out.updates.push(...(u.values ? triple(u.name, u.values) : [`--${u.name}: ${u.value};`]));
  out.places.push(...toPlace);
}

/* ---------- Figma design context ---------- */

const EFFECT_RE = /Effect\(type:\s*(\w+),\s*color:\s*(#[0-9A-Fa-f]{6,8}),\s*offset:\s*\((-?[\d.]+),\s*(-?[\d.]+)\),\s*radius:\s*(-?[\d.]+)(?:,\s*spread:\s*(-?[\d.]+))?\)/g;
const WEIGHT_UTILITY = { 400: "regular", 500: "medium", 600: "semibold", 700: "bold" };

/** "font/weight/Semi Bold" and "font/weight/semi-bold" are both "semibold". */
const weightSlug = (s) => s?.split("/").pop().toLowerCase().replace(/[^a-z]/g, "");

/** The "These styles are contained in the design" line: text styles and effect styles. */
function parseStyles(text) {
  const fonts = [];
  const effects = [];
  const at = text.indexOf("These styles are contained in the design");
  if (at === -1) return { fonts, effects };
  const body = text.slice(at);
  for (const m of body.matchAll(/([A-Za-z][^:(),;]*?):\s*Font\(([^)]*)\)/g)) {
    const f = Object.fromEntries(m[2].split(/,\s*(?=[a-zA-Z]+:)/).map((kv) => [kv.slice(0, kv.indexOf(":")).trim(), kv.slice(kv.indexOf(":") + 1).trim()]));
    const weight = Number(f.weight);
    if (!f.size || !weight) continue;
    fonts.push({
      name: m[1].trim(), size: f.size, weight, weightName: weightSlug(f.style),
      lineHeight: f.lineHeight?.toLowerCase(),
      letter: f.letterSpacing === undefined ? undefined : Number(f.letterSpacing.replace("%", "")),
    });
  }
  let last = null;
  for (const m of body.matchAll(EFFECT_RE)) {
    const name = body.slice(0, m.index).match(/([A-Za-z][^:(),;]*?):\s*$/);
    if (name) {
      last = { name: name[1].trim(), layers: [] };
      effects.push(last);
    }
    last?.layers.push({ type: m[1], color: m[2], x: Number(m[3]), y: Number(m[4]), blur: Number(m[5]), spread: Number(m[6] ?? 0) });
  }
  return { fonts, effects };
}

/** The React-like code of a capture as a tree of nodes, with Tailwind classes decoded. */
function parseCapture(text) {
  const fns = [...text.matchAll(/\bfunction\s+(\w+)/g)].map((m) => ({ at: m.index, name: m[1] }));
  const roots = [];
  const nodes = [];
  const stack = [];
  const TAG = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w-]+(?:=(?:"[^"]*"|\{(?:[^{}]|\{[^{}]*\})*\}))?)*)\s*(\/?)>/g;
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    const between = text.slice(last, m.index).trim();
    if (between && stack.length) stack.at(-1).text += `${stack.at(-1).text ? " " : ""}${between}`;
    last = m.index + m[0].length;
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w-]+)(?:=(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\}))?/g)) {
      attrs[a[1]] = a[3] !== undefined ? (a[1] === "className" ? a[3].match(/"([^"]*)"/)?.[1] ?? "" : a[3].trim()) : a[2] ?? "";
    }
    const node = {
      tag: m[2], id: attrs["data-node-id"], name: attrs["data-name"], attrs, text: "",
      cls: (attrs.className ?? "").replace(/\\/g, "").split(/\s+/).filter(Boolean),
      children: [], parent: stack.at(-1) ?? null, depth: stack.length,
    };
    if (node.parent) node.parent.children.push(node);
    else {
      node.fn = fns.filter((f) => f.at < m.index).at(-1)?.name;
      roots.push(node);
    }
    nodes.push(node);
    if (!m[4]) stack.push(node);
  }
  return { roots, nodes };
}

function readCapture(file) {
  const text = readFileSync(file, "utf8");
  const base = file.split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]context$/i, "");
  return {
    file, text, styles: parseStyles(text), ...parseCapture(text),
    page: base.replace(/[-_](desktop|tablet|mobile)$/i, ""),
    label: base,
  };
}

const clsMatch = (n, re) => {
  for (const c of n.cls) {
    const m = c.match(re);
    if (m) return m;
  }
  return null;
};
const varRef = (s) => {
  const m = s?.match(/var\(--([^,)]+)(?:,([^)]*))?\)/);
  return m ? { name: m[1].replace(/-?\[[^\]]*\]$/, ""), fallback: m[2] } : null;
};
const hexOf = (value) => {
  const v = value?.trim().toLowerCase();
  if (v === "white") return "#ffffff";
  if (v === "black") return "#000000";
  const m = v?.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  return m ? `#${m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1]}` : null;
};
/** A colour from a `var(--color/…,fallback)` or a raw value: its Figma name, the Lumos swatch it is, and its hex. */
function colorFrom(inner) {
  if (!inner) return null;
  const ref = varRef(inner);
  if (!ref) return { raw: inner, hex: hexOf(inner) };
  const hit = tokenFor(ref.name);
  const token = hit?.kind === "color" ? `--${hit.token}` : null;
  return { name: ref.name, token: token && tokens.swatches[token] ? token : null, hex: (token && tokens.swatches[token]) ?? hexOf(ref.fallback) };
}
const colorLabel = (c) => (c ? c.token ?? c.name ?? c.raw : "none");
/** `var(--spacing/2rem,32px)` is "spacing/2rem"; anything else stays as written. */
const shortValue = (s) => varRef(s)?.name ?? s.replace(/_/g, " ");
/** A Figma variable name or a px literal as px at each breakpoint, from the scale in base.css. */
function sizeFrom(s) {
  if (!s) return null;
  const ref = varRef(s);
  if (ref) {
    const token = tokenFor(ref.name)?.token;
    const triple = token && tokens.scale[token];
    return { name: ref.name, token: triple ? token : null, triple: triple || null, px: triple ? triple.desktop : parseFloat(ref.fallback), guessed: !triple };
  }
  const px = parseFloat(s);
  return Number.isNaN(px) ? null : { name: `${px}px`, token: null, triple: null, px };
}

/** The text a node sets: size, weight and line-height variables, colour, transform. Null when it is not a text node. */
function textOf(n) {
  const size = varRef(clsMatch(n, /^text-\[length:(.+)\]$/)?.[1]);
  const weight = clsMatch(n, /^font-\[var\(--(font\/weight\/[^,)]+)/)?.[1];
  if (!size || !weight) return null;
  const slug = weightSlug(weight);
  return {
    sizeVar: size.name, weightName: slug, weight: WEIGHT_NAMES[slug],
    lh: clsMatch(n, /^leading-\[var\(--(line-height\/[^,)]+)/)?.[1].toLowerCase(),
    color: colorFrom(clsMatch(n, /^text-\[color:(.+)\]$/)?.[1]),
    transform: n.cls.find((c) => /^(uppercase|lowercase|capitalize)$/.test(c)) ?? "none",
  };
}

const ancestors = (n) => {
  const out = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
};
const buttonOf = (n) => [n, ...ancestors(n)].find((a) => /button/i.test(a.name ?? ""));
const nameOf = (n) => {
  const chain = [n, ...ancestors(n)];
  return chain.find((a) => a.name)?.name ?? chain.at(-1).fn ?? n.tag;
};
const descendants = (n) => n.children.flatMap((c) => [c, ...descendants(c)]);

/** A shadow-[…] class as layers, in px. */
function parseShadow(value) {
  const layers = [];
  let depth = 0;
  let part = "";
  for (const ch of `${value},`) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      const words = part.split("_").filter(Boolean);
      const inset = words[0] === "inset";
      const nums = words.filter((t) => /^-?[\d.]+(px)?$/.test(t)).map(parseFloat);
      const color = words.find((t) => /^(rgba?\(|#)/.test(t));
      if (nums.length >= 3 && color) layers.push({ inset, x: nums[0], y: nums[1], blur: nums[2], spread: nums[3] ?? 0, color });
      part = "";
    } else part += ch;
  }
  return layers;
}
const cssNum = (px) => (px === 0 ? "0" : `${+(px / ROOT_PX).toFixed(4)}rem`);
const cssColor = (c) => {
  const m = c.match(/^rgba?\(([^)]*)\)$/);
  if (!m) return c;
  const [r, g, b, a] = m[1].split(",").map((s) => s.trim());
  return a === undefined || Number(a) === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a})`;
};
const shadowCss = (layers) => layers.map((l) => `${l.inset ? "inset " : ""}${cssNum(l.x)} ${cssNum(l.y)} ${cssNum(l.blur)} ${cssNum(l.spread)} ${cssColor(l.color)}`).join(", ");
/** A layer reduced to comparable numbers: Figma writes #RRGGBBAA, the code writes rgba(). */
function shadowKey(l, withSpread = true) {
  let rgba;
  const hex = l.color.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) rgba = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(hex[2] ? +(parseInt(hex[2], 16) / 255).toFixed(2) : 1);
  else rgba = (l.color.match(/[\d.]+/g) ?? []).map(Number).concat(1).slice(0, 4).map((v, i) => (i === 3 ? +v.toFixed(2) : v));
  return [l.x, l.y, l.blur, ...(withSpread ? [l.spread] : []), ...rgba].join(",");
}
const shadowKeys = (layers, withSpread = true) => layers.map((l) => shadowKey(l, withSpread)).sort().join("|");

/** What a button node sets: fill, text, border, radius, padding, gap, and the text style inside. */
function buttonSpec(btn, rowFor) {
  const inner = [btn, ...descendants(btn)];
  const text = inner.find((n) => n.text && textOf(n));
  const info = text ? textOf(text) : null;
  const gapNode = inner.find((n) => clsMatch(n, /^gap-\[/));
  const padding = (axis) => sizeFrom(clsMatch(btn, new RegExp(`^p${axis}-\\[(.+)\\]$`))?.[1] ?? clsMatch(btn, /^p-\[(.+)\]$/)?.[1]);
  const width = btn.cls.includes("border") ? 1 : Number(clsMatch(btn, /^border-\[(\d+)px\]$/)?.[1] ?? 0);
  const row = info ? rowFor(info) : null;
  return {
    name: btn.name, id: btn.id, iconOnly: !text,
    fill: colorFrom(clsMatch(btn, /^bg-\[(var\(.+\))\]$/)?.[1]),
    text: info?.color ?? null,
    border: width ? { width, color: colorFrom(clsMatch(btn, /^border-\[(var\(.+\))\]$/)?.[1]) } : null,
    radius: sizeFrom(clsMatch(btn, /^rounded-\[(.+)\]$/)?.[1]),
    padX: padding("x"), padY: padding("y"),
    gap: sizeFrom(gapNode && clsMatch(gapNode, /^gap-\[(.+)\]$/)[1]),
    style: info && { ...info, row },
  };
}

/** The light theme block and :root, followed through var() until a value or a swatch is reached. */
function resolveVar(name) {
  const via = [];
  let cur = name;
  for (let i = 0; i < 10; i++) {
    const v = tokens.themeLight[cur] ?? tokens.rootVars[cur];
    if (v === undefined) return { name: cur, via, value: null };
    const m = v.match(/^var\((--[a-z0-9-]+)(?:,[^)]*)?\)$/);
    if (!m) return { name: cur, via, value: v };
    via.push(cur);
    cur = m[1];
  }
  return { name: cur, via, value: null };
}

/** The theme blocks of base.css by name: light (:root), dark and brand, each as its own variable map. */
function themeBlocks() {
  const blocks = { light: tokens.themeLight };
  for (const [name, re] of [["dark", /(?:^|\n)(\.theme-dark,[^{]*)\{([^}]*)\}/], ["brand", /(?:^|\n)(\.theme-brand\s*)\{([^}]*)\}/]]) {
    const m = css.match(re);
    if (m) blocks[name] = Object.fromEntries([...m[2].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
  }
  return blocks;
}

/** A variable followed through var() in one theme (then :root) to the swatch or literal it ends at. */
function resolveIn(name, vars) {
  let cur = name;
  for (let i = 0; i < 10; i++) {
    const v = vars[cur] ?? tokens.themeLight[cur] ?? tokens.rootVars[cur];
    if (v === undefined) return { token: null, value: null };
    const m = v.match(/^var\((--[a-z0-9-]+)(?:,[^)]*)?\)$/);
    if (!m) return { token: tokens.swatches[cur] ? cur : null, value: v };
    cur = m[1];
  }
  return { token: null, value: null };
}

/**
 * The project's Button as concrete configurations: every size class in Button.astro that overrides
 * --button-* sizes (`&.small { … }`), crossed with primary/secondary emphasis and each theme.
 * Null when the component cannot be read.
 */
function buttonConfigs() {
  let src;
  try {
    src = readFileSync(join(cssPath, "..", "..", "components", "Button.astro"), "utf8");
  } catch {
    return null;
  }
  const SIZE_VARS = /(--button-(?:radius|padding-block|padding-inline|gap|font-size|font-weight|line-height|letter-spacing|border-inset)):\s*([^;]+);/g;
  const sizes = { main: {} };
  for (const m of src.matchAll(/&\.([a-z0-9-]+)\s*\{([^{}]*)\}/g)) {
    const decl = Object.fromEntries([...m[2].matchAll(SIZE_VARS)].map((x) => [x[1], x[2].trim()]));
    if (Object.keys(decl).length) sizes[m[1]] = decl;
  }
  const configs = [];
  /* The link variant draws no box: only its weight (from `&.link { font-weight }`) and --link-text matter. */
  const linkWeightRef = src.match(/&\.link\s*\{[^}]*?font-weight:\s*var\((--primary-[a-z]+)\)/)?.[1];
  for (const [theme, vars] of Object.entries(themeBlocks())) {
    if (/&\.link\s*\{/.test(src)) {
      const fontToken = tokens.rootVars["--button-font-size"]?.match(/^var\(--([a-z0-9-]+)\)$/)?.[1] ?? null;
      configs.push({
        theme, emphasis: "link", size: "main", props: 'variant="link"',
        radius: null, padY: 0, padX: 0, font: fontToken,
        weight: linkWeightRef ? tokens.weights[linkWeightRef] : null,
        fill: { token: null, value: "transparent" }, text: resolveIn("--link-text", vars), border: { token: null, value: null },
      });
    }
    for (const emphasis of ["primary", "secondary"]) {
      for (const [size, over] of Object.entries(sizes)) {
        const v = (name) => over[name] ?? tokens.rootVars[name];
        const colour = (role) => resolveIn(emphasis === "secondary" ? role.replace("--button-", "--button-2-") : role, vars);
        const fontToken = v("--button-font-size")?.match(/^var\(--([a-z0-9-]+)\)$/)?.[1] ?? null;
        const fontPx = fontToken ? tokens.scale[fontToken]?.desktop : null;
        const weightRef = v("--button-font-weight")?.match(/^var\((--primary-[a-z]+)\)$/)?.[1];
        configs.push({
          theme, emphasis, size,
          props: [emphasis !== "primary" && `emphasis="${emphasis}"`, size !== "main" && `size="${size}"`].filter(Boolean).join(" ") || "(default)",
          radius: projectPx(v("--button-radius"), fontPx),
          padY: projectPx(v("--button-padding-block"), fontPx),
          padX: projectPx(v("--button-padding-inline"), fontPx),
          font: fontToken,
          weight: weightRef ? tokens.weights[weightRef] : Number(v("--button-font-weight")) || null,
          fill: colour("--button-background"),
          text: colour("--button-text"),
          border: colour("--button-border"),
        });
      }
    }
  }
  return configs;
}

/** Where a Figma text button differs from one Button configuration; an empty list is a match. */
function buttonDiff(s, c) {
  const diffs = [];
  const num = (what, figma, project) => {
    if (figma === undefined || figma === null) return;
    if (project === null || Math.abs(figma - project) > 0.5) diffs.push(`${what} ${figma} vs ${project ?? "?"}`);
  };
  num("radius", s.radius?.px, c.radius);
  num("padding-y", s.padY?.px, c.padY);
  num("padding-x", s.padX?.px, c.padX);
  const font = s.style ? tokenFor(s.style.sizeVar)?.token : null;
  if (font && font !== c.font) diffs.push(`font ${font} vs ${c.font ?? "?"}`);
  if (s.style && c.weight && s.style.weight !== c.weight) diffs.push(`weight ${s.style.weight} vs ${c.weight}`);
  const colour = (what, figma, project) => {
    const figmaToken = figma?.token ?? null;
    const clear = (x) => !x || x.value === "transparent";
    if (!figma) {
      if (!clear(project) && project.token) diffs.push(`${what} none vs ${project.token}`);
      return;
    }
    if (!figmaToken) return;
    if (!project?.token) {
      if (project?.value) diffs.push(`${what} ${figmaToken} vs ${project.value}`);
      return;
    }
    if (figmaToken !== project.token) diffs.push(`${what} ${figmaToken} vs ${project.token}`);
  };
  colour("fill", s.fill, c.fill);
  colour("text", s.text, c.text);
  if (s.border) colour("border", s.border.color, c.border);
  return diffs;
}
/** Project value of a `--button-*` size token as px, given the button's font size. Null when it is not a length. */
function projectPx(value, fontPx) {
  let m;
  if ((m = value?.match(/^(-?[\d.]+)em$/))) return fontPx ? +(Number(m[1]) * fontPx).toFixed(2) : null;
  if ((m = value?.match(/^(-?[\d.]+)rem$/))) return Number(m[1]) * ROOT_PX;
  if ((m = value?.match(/^(-?[\d.]+)px$/))) return Number(m[1]);
  if ((m = value?.match(/^var\(--([a-z0-9-]+)\)$/))) return tokens.scale[m[1]]?.desktop ?? null;
  return null;
}

/** Weight, tracking, colour, effects, buttons, assets and clipped nodes for every text style and node a get_design_context capture uses. */
function runDesignContext(files) {
  const caps = files.map(readCapture);
  const fonts = caps.flatMap((c) => c.styles.fonts);
  const rows = new Map();
  const ensure = (sizeVar, weight, name) => {
    const key = `${sizeVar.toLowerCase()}|${weight}`;
    if (!rows.has(key)) {
      rows.set(key, { sizeVar, weight, weightName: name, styles: new Set(), lhVars: new Set(), letters: new Set(), transforms: new Set(), nodes: 0, buttonNodes: 0, pages: new Map() });
    }
    return rows.get(key);
  };
  for (const f of fonts) {
    /* letterSpacing in the styles line is percent. */
    const row = ensure(f.size, f.weight, f.weightName);
    row.styles.add(f.name);
    if (f.lineHeight) row.lhVars.add(f.lineHeight);
    if (f.letter !== undefined) row.letters.add(f.letter);
  }

  /* The code carries the variable names and is the only place text-transform and colours show up. Its px fallbacks are desktop-mode values and are ignored. */
  const colors = { heading: new Map(), text: new Map(), label: new Map() };
  const textNodes = caps.flatMap((c) => c.nodes.map((n) => ({ n, c, t: n.text ? textOf(n) : null })).filter((x) => x.t));
  for (const { n, c, t } of textNodes) {
    const row = ensure(t.sizeVar, t.weight, t.weightName);
    const inButton = Boolean(buttonOf(n));
    if (inButton) row.buttonNodes++;
    else {
      row.nodes++;
      row.pages.set(c.page, (row.pages.get(c.page) ?? 0) + 1);
    }
    row.transforms.add(t.transform);
    if (t.lh) row.lhVars.add(t.lh);
    if (inButton || !t.color) continue;
    /* Overline and tag styles are labels: a muted or accent label colour must not outvote the body colour for --text. */
    const role = /^font-size\/heading\//i.test(t.sizeVar) ? "heading" : /^font-size\/overline\//i.test(t.sizeVar) ? "label" : "text";
    const key = colorLabel(t.color);
    const entry = colors[role].get(key) ?? { color: t.color, count: 0, styles: new Map() };
    entry.count++;
    const style = tokenFor(t.sizeVar)?.token ?? t.sizeVar;
    entry.styles.set(style, (entry.styles.get(style) ?? 0) + 1);
    colors[role].set(key, entry);
  }
  if (!rows.size) console.log("No text styles found in the design-context capture(s) — expected the 'These styles are contained in the design' line.");

  const isButtonRow = (r) => (r.styles.size ? [...r.styles].every((s) => /^button\b/i.test(s)) : !r.nodes && r.buttonNodes > 0);
  for (const r of rows.values()) {
    const hit = /^font-size\//i.test(r.sizeVar) ? tokenFor(r.sizeVar) : null;
    r.token = hit && hit.kind === "scale" && !isLineHeight(hit.token) ? hit.token : null;
    r.button = isButtonRow(r);
  }
  const textRows = [...rows.values()].filter((r) => !r.button);
  const byToken = new Map();
  for (const r of textRows) if (r.token) byToken.set(r.token, [...(byToken.get(r.token) ?? []), r]);
  const em = (pct) => +(pct / 100).toFixed(4);
  const distinctEm = (list) => [...new Set(list.map(em))].sort((a, b) => a - b);
  const spreadEm = (list) => list.length > 0 && Math.max(...list.map(em)) - Math.min(...list.map(em)) > LETTER_EPS;
  const namesOf = (r) => [...r.styles].join(", ") || "(from code, no style name)";

  const table = [];
  const weightLines = [];
  for (const r of [...textRows].sort((a, b) => (a.token ?? "~").localeCompare(b.token ?? "~") || a.weight - b.weight)) {
    const names = namesOf(r);
    const letters = [...r.letters];
    const transform = r.nodes ? ([...r.transforms].length === 1 ? [...r.transforms][0] : "mixed") : null;
    const figma = [
      `w${r.weight}${r.weightName ? ` ${r.weightName}` : ""}`,
      letters.length ? letters.map((l) => `${em(l)}em`).join("/") : "tracking n/a",
      [...r.lhVars].join("/") || "line height n/a",
      transform && transform !== "none" ? transform : null,
    ].filter(Boolean).join(" · ");
    const T = r.token;
    if (!T || !tokens.scale[T]) {
      table.push([names, figma, "—", "UNMAPPED", "—"]);
      out.asks.push(`${names}: ${T ? `--${T} is not in base.css` : `size ${r.sizeVar} maps to no text token`}. Which token is this style, or is it new?`);
      continue;
    }
    const group = byToken.get(T);
    const curW = tokens.styleWeight[T];
    const curL = tokens.styleLetter[T];
    const curT = tokens.styleTransform[T];
    const base = [
      curW ? `w${curW.value}${curW.token ? ` (${curW.token})` : ""}` : "weight n/a",
      curL ? `${curL.em}em${curL.token ? ` (${curL.token})` : ""}` : "tracking n/a",
      `--${T}-line-height`,
      curT && curT !== "none" ? curT : null,
    ].filter(Boolean).join(" · ");
    const weightsSeen = [...new Set(group.map((x) => x.weight))];
    const lettersSeen = group.flatMap((x) => [...x.letters]);
    const conflicts = [];
    if (weightsSeen.length > 1 && !weightsCovered(curW?.value, weightsSeen)) conflicts.push("weight");
    if (spreadEm(lettersSeen)) conflicts.push("letter-spacing");
    if (transform === "mixed") conflicts.push("text-transform");

    const kinds = [];
    if (curW?.value !== r.weight && !(weightsSeen.length > 1 && weightsCovered(curW?.value, weightsSeen))) kinds.push("weight");
    if (letters.length === 1 && Math.abs((curL?.em ?? 0) - em(letters[0])) > LETTER_EPS) kinds.push("letter-spacing");
    if (transform && transform !== "mixed" && (curT ?? "none") !== transform) kinds.push("text-transform");

    const lhTokens = [...r.lhVars].map((v) => tokenFor(v)?.token);
    const lhNote = !r.lhVars.size ? "n/a"
      : lhTokens.every((t) => t === `${T}-line-height`)
        ? { match: "triples match", differs: "triples DIFFER", missing: "token missing" }[varStatus.get(`${T}-line-height`)] ?? "own token; add --variables to compare"
        : `uses ${lhTokens.map((t) => `--${t}`).join("/")}`;
    if (r.lhVars.size && lhTokens.some((t) => t !== `${T}-line-height`)) {
      out.asks.push(`${names}: its line height variable (${[...r.lhVars].join("/")}) is not --${T}-line-height. Is that deliberate?`);
      kinds.push("line-height");
    }
    const viaUtility = curW?.value !== r.weight && hasWeightUtility(r.weight) && weightsCovered(curW?.value, weightsSeen);
    const status = conflicts.length ? `CONFLICT (${conflicts.join(", ")})` : kinds.length ? `DIFFERS (${[...new Set(kinds)].join(", ")})` : viaUtility ? `MATCH via .weight-${WEIGHT_UTILITY[r.weight]}` : "MATCH";
    table.push([names, figma, base, status, `--${T}-line-height: ${lhNote}`]);
    weightLines.push(`--${T}  ${names}: Figma ${r.weight}${r.weightName ? ` ${r.weightName}` : ""}, project ${curW?.value ?? "n/a"}${curW?.token ? ` (${curW.token})` : ""} — ${conflicts.includes("weight") ? "CONFLICT" : curW?.value === r.weight ? "match" : viaUtility ? `match via .weight-${WEIGHT_UTILITY[r.weight]}` : "DIFFERS"}`);
  }

  /* One question and one set of update lines per text token, however many styles share it. */
  const covered = [];
  for (const [T, group] of byToken) {
    if (!tokens.scale[T]) continue;
    const curW = tokens.styleWeight[T];
    const curL = tokens.styleLetter[T];
    const curT = tokens.styleTransform[T];
    const names = [...new Set(group.flatMap((r) => [...r.styles]))].join(", ") || T;
    const weightsSeen = [...new Set(group.map((r) => r.weight))];
    const lettersSeen = group.flatMap((r) => [...r.letters]);
    const transforms = new Set(group.filter((r) => r.nodes).flatMap((r) => [...r.transforms]));
    const issues = [];
    let conflict = false;
    if (weightsSeen.length > 1) {
      const counts = weightsSeen.map((w) => {
        const rs = group.filter((r) => r.weight === w);
        const pages = new Map();
        for (const r of rs) for (const [p, n] of r.pages) pages.set(p, (pages.get(p) ?? 0) + n);
        return { w, n: rs.reduce((a, r) => a + r.nodes, 0), names: [...new Set(rs.flatMap((r) => [...r.styles]))].join(", "), pages: [...pages].map(([p, n]) => `${p} ×${n}`).join(", ") };
      });
      const minority = weightsSeen.filter((w) => w !== curW?.value);
      if (weightsCovered(curW?.value, weightsSeen)) {
        covered.push(`--${T}: default ${curW.value} (base.css); ${minority.map((w) => `${w} → .weight-${WEIGHT_UTILITY[w]}`).join(", ")} (utilities.css). Nothing to ask.`);
      } else {
        conflict = true;
        const top = [...counts].sort((a, b) => b.n - a.n)[0].w;
        issues.push(`used with weights ${counts.map((c) => `${c.w} ×${c.n} node(s) (${c.names || "unnamed"}${c.pages ? `; ${c.pages}` : ""})`).join(" and ")}, but base.css has one value per style (weight ${curW?.value ?? "n/a"}). Suggest the most used (${top}) as the default and the rest as .weight-${weightsSeen.filter((w) => w !== top).map((w) => WEIGHT_UTILITY[w] ?? w).join(" / .weight-")}`);
      }
    } else if (curW?.value !== weightsSeen[0]) {
      issues.push(`weight ${weightsSeen[0]} vs project ${curW?.value ?? "n/a"}${curW?.token ? ` (${curW.token})` : ""}`);
      let ref = Object.entries(tokens.weights).find(([, v]) => v === weightsSeen[0])?.[0];
      if (!ref) {
        const name = `primary-${group[0].weightName ?? `w${weightsSeen[0]}`}`;
        out.places.push({ name, value: String(weightsSeen[0]) });
        ref = `--${name}`;
      }
      out.updates.push(`--${T}-font-weight: var(${ref});`);
    }
    if (lettersSeen.length) {
      if (spreadEm(lettersSeen)) {
        conflict = true;
        issues.push(`letter spacing ${distinctEm(lettersSeen).map((l) => `${l}em`).join(" and ")} across its styles`);
      } else if (Math.abs((curL?.em ?? 0) - em(lettersSeen[0])) > LETTER_EPS) {
        const value = em(lettersSeen[0]);
        issues.push(`letter spacing ${value}em vs project ${curL?.em ?? "n/a"}em${curL?.token ? ` (${curL.token})` : ""}`);
        const reuse = nearestValue(value, tokens.letterSpacing);
        let ref = reuse?.name;
        if (!reuse || reuse.delta > LETTER_EPS) {
          const pct = +lettersSeen[0].toFixed(3);
          const name = `letter-spacing-${pct < 0 ? "neg-" : ""}${String(Math.abs(pct)).replace(".", "-")}`;
          out.places.push({ name, value: `${value}em` });
          ref = `--${name}`;
        }
        out.updates.push(`--${T}-letter-spacing: var(${ref});`);
      }
    }
    if (transforms.size > 1) {
      conflict = true;
      issues.push("both transformed and plain text");
    } else if (transforms.size === 1 && (curT ?? "none") !== [...transforms][0]) {
      const t = [...transforms][0];
      issues.push(`text-transform ${t} vs project ${curT ?? "none"}`);
      out.updates.push(`--${T}-text-transform: ${t};`);
    }
    if (issues.length) {
      out.asks.push(`${names} (--${T}): ${issues.join("; ")}. ${conflict ? "Which is the default, and are the others variants handled by another class?" : "Apply to this project, or keep the template default?"}`);
    }
  }

  if (table.length) {
    console.log("FIGMA is weight · letter spacing (em) · line-height variable · text-transform; letter spacing comes from the styles line, never from the px fallbacks in the code.\n");
    printTable(["STYLE", "FIGMA", "BASE.CSS", "STATUS", "LINE HEIGHT"], table);
    console.log("\nWEIGHT (every text style, Figma vs project):");
    for (const l of weightLines) console.log(`  ${l}`);
    if (covered.length) {
      console.log("\nMINORITY WEIGHTS ALREADY COVERED (default in base.css, the rest by existing utilities):");
      for (const l of covered) console.log(`  ${l}`);
    }
  }

  /* ---- text colours ---- */
  const dominant = (m) => [...m.values()].sort((a, b) => b.count - a.count)[0];
  if (colors.heading.size || colors.text.size || colors.label.size) {
    console.log("\nTEXT COLOURS (heading styles set --heading, body styles set --text, overline and tag styles are labels and set neither; light theme resolved):");
    const colorRows = [];
    for (const [role, entries] of Object.entries(colors)) {
      if (role === "label") continue;
      const top = dominant(entries);
      if (!top) continue;
      const cur = resolveVar(`--${role}`);
      const same = top.color.token ? cur.name === top.color.token : top.color.hex && hexOf(cur.value) === top.color.hex;
      const path = cur.via.length ? ` (via ${cur.via.join(" → ")})` : "";
      colorRows.push([`--${role}`, `${colorLabel(top.color)} ×${top.count}${top.color.hex ? ` ${top.color.hex}` : ""}`, `${cur.name}${path}`, same ? "MATCH" : top.color.token ? "DIFFERS" : "UNMAPPED"]);
      if (!same) {
        if (top.color.token) out.updates.push(`--${role}: var(${top.color.token});`);
        out.asks.push(`--${role}: Figma text uses ${colorLabel(top.color)} (${top.count} node(s))${top.color.token ? "" : ` ${top.color.hex ?? ""}, which has no --color-* swatch yet`}, base.css has ${cur.name}. ${top.color.token ? `Set --${role}: var(${top.color.token}); in EVERY theme block (:root/.theme-light, .theme-dark, .theme-brand), or keep the template default?` : "Add the swatch first?"}`);
      }
    }
    printTable(["ROLE", "FIGMA (most used)", "BASE.CSS (light)", "STATUS"], colorRows);
    const others = [];
    for (const [role, entries] of Object.entries(colors)) {
      const top = role === "label" ? null : dominant(entries);
      for (const e of entries.values()) {
        if (e === top) continue;
        const near = e.color.token ? { name: e.color.token, d: 0 } : e.color.hex ? nearestSwatch(e.color.hex, tokens.swatches) : null;
        others.push([role, colorLabel(e.color), e.color.hex ?? "—", `${e.count}`, [...e.styles].map(([s, n]) => `${s}×${n}`).join(" "), near ? `${near.name}${near.d ? ` (${near.d} away)` : ""}` : "—"]);
      }
    }
    if (others.length) {
      console.log("\nOTHER TEXT COLOURS (one row each; the most used colour of a role is in the table above):");
      printTable(["ROLE", "FIGMA", "HEX", "NODES", "USED BY", "CLOSEST TOKEN"], others);
      out.asks.push(`Text colours besides --heading/--text: ${others.map((o) => `${o[1]} ×${o[3]}`).join(", ")}. Which are roles that deserve a token (muted label, caption, accent eyebrow…), and which are one-offs?`);
    }
  }

  /* ---- effects ---- */
  const shadows = new Map();
  for (const c of caps) {
    for (const n of c.nodes) {
      const m = clsMatch(n, /^(drop-)?shadow-\[(.+)\]$/);
      if (!m) continue;
      /* A drop-shadow filter writes half the blur of a box shadow and cannot express spread. */
      const drop = Boolean(m[1]);
      const layers = parseShadow(m[2]).map((l) => (drop ? { ...l, blur: l.blur * 2 } : l));
      if (!layers.length) continue;
      const style = c.styles.effects.find((e) => e.layers.length === layers.length && shadowKeys(e.layers, !drop) === shadowKeys(layers, !drop));
      const key = style ? `style:${style.name}` : `${drop ? "drop:" : ""}${shadowKeys(layers)}`;
      const entry = shadows.get(key) ?? { layers: style ? style.layers : layers, drop, nodes: 0, names: new Set(), effect: style?.name };
      entry.nodes++;
      entry.names.add(nameOf(n));
      shadows.set(key, entry);
    }
  }
  const effectStyles = new Map(caps.flatMap((c) => c.styles.effects.map((e) => [e.name, e])));
  if (shadows.size || effectStyles.size) {
    console.log("\nSHADOWS (Figma effect styles are not in a variable export; these come from the node classes and the styles line):");
    const blur = (s) => Math.max(...s.layers.map((l) => l.blur));
    const reach = (s) => Math.max(...s.layers.map((l) => Math.abs(l.y)));
    const ranked = [...shadows.values()].sort((a, b) => blur(a) - blur(b) || reach(a) - reach(b));
    const SCALE = ranked.length === 1 ? ["medium"] : ranked.length === 2 ? ["small", "large"] : ["small", "medium", "large", "xlarge", "2xlarge"];
    /* A shadow equal to a Figma effect style takes that style's name (Shadow/Small -> shadow-small); only the rest are named by rank. */
    const styleToken = (s) => (s.effect ? `shadow-${s.effect.replace(/^.*\//, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : null);
    const taken = new Set(ranked.map(styleToken).filter(Boolean));
    const rankFree = SCALE.map((n) => `shadow-${n}`).filter((n) => !taken.has(n));
    const shadowRows = [];
    let rankAt = 0;
    ranked.forEach((s, i) => {
      s.token = styleToken(s) ?? rankFree[rankAt++] ?? `shadow-${i + 1}`;
      const existing = css.match(new RegExp(`--${s.token}:\\s*([^;]+);`))?.[1];
      shadowRows.push([s.token, `${s.nodes}`, [...s.names].slice(0, 3).join(", "), s.effect ? `= Figma ${s.effect}${s.drop ? " (code uses drop-shadow)" : ""}` : `no equal Figma effect style${s.drop ? " (drop-shadow, spread unknown)" : ""}`, existing ? "already in base.css — compare by hand" : "NEW"]);
      out.places.push({ name: s.token, value: shadowCss(s.layers) });
    });
    if (shadowRows.length) printTable(["SUGGESTED", "NODES", "USED BY", "FIGMA EFFECT STYLE", "BASE.CSS"], shadowRows);
    if (effectStyles.size) {
      console.log("  Figma effect styles in the styles line:");
      for (const e of effectStyles.values()) console.log(`    ${e.name}: ${shadowCss(e.layers.map((l) => ({ ...l, color: l.color })))}`);
    }
    const unmatched = ranked.filter((s) => effectStyles.size && !s.effect);
    out.asks.push(`Shadows: ${ranked.length} distinct in the nodes (${ranked.map((s) => `${s.token} ×${s.nodes}`).join(", ")}). Add them as --shadow-* tokens?${unmatched.length ? ` ${unmatched.map((s) => s.token).join(", ")} differ from every Figma effect style in blur, offset or spread — which is right?` : ""}`);
  }

  /* ---- buttons ---- */
  const rowFor = (t) => rows.get(`${t.sizeVar.toLowerCase()}|${t.weight}`);
  const buttonNodes = caps.flatMap((c) => c.nodes.filter((n) => /button/i.test(n.name ?? "") && !ancestors(n).some((a) => /button/i.test(a.name ?? ""))).map((n) => ({ n, c })));
  if (buttonNodes.length) {
    const variants = new Map();
    for (const { n } of buttonNodes) {
      const spec = buttonSpec(n, rowFor);
      const state = n.name.match(/\bis-[a-z]+/i)?.[0];
      const sig = JSON.stringify([n.name.replace(/\s*\bis-[a-z]+/i, ""), colorLabel(spec.fill), spec.border && [spec.border.width, colorLabel(spec.border.color)], colorLabel(spec.text), spec.radius?.name, spec.padX?.name, spec.padY?.name, spec.gap?.name, spec.style && [spec.style.sizeVar, spec.style.weight]]);
      const v = variants.get(sig) ?? { spec, count: 0, states: new Set() };
      v.count++;
      if (state) v.states.add(state);
      variants.set(sig, v);
    }
    console.log("\nBUTTONS (nodes whose data-name contains \"button\"; each variant one row):");
    const baseName = (v) => v.spec.name.replace(/\s*\bis-[a-z]+/i, "");
    const seen = {};
    for (const v of [...variants.values()].sort((x, y) => y.count - x.count)) {
      seen[baseName(v)] = (seen[baseName(v)] ?? 0) + 1;
      v.label = baseName(v);
      v.index = seen[baseName(v)];
    }
    for (const v of variants.values()) v.label = `${baseName(v)}${seen[baseName(v)] > 1 ? ` #${v.index}` : ""}${v.states.size ? ` (${[...v.states].join(", ")})` : ""}`;
    const buttonRows = [...variants.values()].map(({ spec: s, count, label }) => [
      `${label} ×${count}`,
      s.iconOnly ? "icon only" : "text",
      colorLabel(s.fill), colorLabel(s.text),
      s.border ? `${s.border.width}px ${colorLabel(s.border.color)}` : "none",
      s.radius?.name ?? "—",
      `${s.padX?.name ?? "—"} × ${s.padY?.name ?? "—"}`,
      s.gap?.name ?? "—",
      s.style ? `${tokenFor(s.style.sizeVar)?.token ?? s.style.sizeVar} w${s.style.weight}${s.style.row?.styles.size ? ` (${[...s.style.row.styles].filter((x) => /^button/i.test(x)).join(", ") || [...s.style.row.styles][0]})` : ""}` : "—",
    ]);
    printTable(["VARIANT", "KIND", "FILL", "TEXT", "BORDER", "RADIUS", "PADDING X × Y", "GAP", "TEXT STYLE"], buttonRows);

    const role = tokens.rootVars;
    const lines = [];
    const textVariants = [...variants.values()].filter((v) => !v.spec.iconOnly).sort((a, b) => b.count - a.count);
    for (const { spec: s, count, label } of textVariants) {
      const fontPx = s.style ? tokens.scale[tokenFor(s.style.sizeVar)?.token]?.desktop : null;
      const cmp = (token, figmaPx, ref, what, projectValue = role[token], triple = null) => {
        if (figmaPx === undefined || figmaPx === null || Number.isNaN(figmaPx)) return;
        const proj = projectPx(projectValue, fontPx);
        const ok = proj !== null && Math.abs(proj - figmaPx) <= 0.5;
        lines.push([`${label} ×${count}`, token, `${what} = ${figmaPx}px${triple && new Set([triple.desktop, triple.tablet, triple.mobile]).size > 1 ? ` (${fmt(triple)})` : ""}`, `${projectValue ?? "—"}${proj !== null ? ` ≈ ${proj}px` : ""}`, ok ? "MATCH" : "DIFFERS", ok ? "" : `${token}: ${ref};`]);
      };
      cmp("--button-radius", s.radius?.px, s.radius?.token ? `var(--${s.radius.token})` : `${s.radius?.px}px`, s.radius?.name ?? "radius", undefined, s.radius?.triple);
      cmp("--button-padding-block", s.padY?.px, s.padY?.token ? `var(--${s.padY.token})` : `${s.padY?.px}px`, s.padY?.name ?? "padding", undefined, s.padY?.triple);
      cmp("--button-padding-inline", s.padX?.px, s.padX?.token ? `var(--${s.padX.token})` : `${s.padX?.px}px`, s.padX?.name ?? "padding", undefined, s.padX?.triple);
      cmp("--button-gap", s.gap?.px, s.gap?.token ? `var(--${s.gap.token})` : `${s.gap?.px}px`, s.gap?.name ?? "gap", undefined, s.gap?.triple);
      cmp("--button-border-inset", s.border?.width ?? 0, `${+((s.border?.width ?? 0) / ROOT_PX).toFixed(4)}rem`, "border");
      if (s.style) {
        const t = tokenFor(s.style.sizeVar)?.token;
        const lhToken = s.style.lh && tokenFor(s.style.lh)?.token;
        const lhPx = lhToken && tokens.scale[lhToken]?.desktop;
        const ratio = lhPx && fontPx ? +(lhPx / fontPx).toFixed(4) : null;
        const w = Object.entries(tokens.weights).find(([, v]) => v === s.style.weight)?.[0];
        const letter = s.style.row && [...s.style.row.letters][0];
        lines.push([`${label} ×${count}`, "--button-font-size", s.style.sizeVar, role["--button-font-size"] ?? "—", role["--button-font-size"] === "initial" ? "DIFFERS (project inherits)" : "check", t ? `--button-font-size: var(--${t});` : ""]);
        lines.push([`${label} ×${count}`, "--button-font-weight", `w${s.style.weight}`, role["--button-font-weight"] ?? "—", `${role["--button-font-weight"] === "initial" ? "DIFFERS (project inherits)" : "check"}`, w ? `--button-font-weight: var(${w});` : ""]);
        if (ratio !== null) lines.push([`${label} ×${count}`, "--button-line-height", `${s.style.lh} = ${lhPx}px/${fontPx}px at desktop`, role["--button-line-height"] ?? "—", Math.abs(Number(role["--button-line-height"]) - ratio) < 0.01 ? "MATCH" : "DIFFERS", `--button-line-height: ${ratio};`]);
        if (letter !== undefined) lines.push([`${label} ×${count}`, "--button-letter-spacing", `${em(letter)}em`, role["--button-letter-spacing"] ?? "—", Math.abs(parseFloat(role["--button-letter-spacing"]) - em(letter)) <= LETTER_EPS ? "MATCH" : "DIFFERS", `--button-letter-spacing: ${em(letter)}em;`]);
      }
      const theme = (token, color, what) => {
        if (!color?.token) return;
        const cur = resolveVar(token);
        lines.push([`${label} ×${count}`, token, `${what} ${colorLabel(color)}`, cur.name, cur.name === color.token ? "MATCH" : "DIFFERS", cur.name === color.token ? "" : `${token}: var(${color.token});  (every theme block)`]);
      };
      theme("--button-background", s.fill, "fill");
      theme("--button-text", s.text, "text");
      if (s.border) theme("--button-border", s.border.color, "border");
    }
    /* Against the project's Button: a Figma variant that equals an existing configuration in some theme needs no question. */
    const configs = buttonConfigs() ?? [];
    const verdicts = textVariants.map((v) => {
      const best = configs.map((c) => ({ c, d: buttonDiff(v.spec, c) })).sort((a, b) => a.d.length - b.d.length)[0];
      return { v, best };
    });
    const primaryCovered = configs.length > 0 && verdicts.some(({ best }) => !best.d.length);
    if (verdicts.length && configs.length) {
      console.log("\nBUTTON VARIANTS vs Button.astro (each Figma text variant against every size class × emphasis × theme the project has):");
      printTable(["VARIANT", "STATUS", "CLOSEST <Button>", "DIFFERS"], verdicts.map(({ v, best }) => [
        `${v.label} ×${v.count}`,
        best.d.length ? "NEW" : "COVERED",
        `${best.c.props} in ${best.c.theme} theme`,
        best.d.join("; ") || "—",
      ]));
    }
    if (lines.length && !primaryCovered) {
      console.log("\nBUTTON TOKENS vs base.css (px: Figma desktop values; em in base.css taken at the button's own font size; button tokens are single values, so tablet and mobile are not compared):");
      printTable(["VARIANT", "TOKEN", "FIGMA", "BASE.CSS", "STATUS", "READY LINE"], lines);
    }
    console.log("  Strokes sit INSIDE the box in Figma and Lumos is border-box: the padding above already includes the border. Set --button-border-inset to the border width instead of adding size.");
    if (primaryCovered) {
      const fresh = verdicts.filter(({ best }) => best.d.length);
      if (fresh.length) out.asks.push(`Buttons: ${fresh.map(({ v, best }) => `${v.label} ×${v.count} (closest ${best.c.props} in ${best.c.theme} theme; ${best.d.join(", ")})`).join("; ")} match no existing Button configuration. For each: a new size/variant in Button.astro, a theme override, or a one-off?`);
    } else {
      const names = [...new Set(buttonRows.map((r) => r[0]))].join("; ");
      out.asks.push(`Buttons: ${buttonRows.length} variant(s) — ${names}. Which is the primary one that --button-* should describe? Nothing was applied.`);
    }
  }

  /* ---- assets ---- */
  const assets = new Map();
  const taken = new Set();
  /* A constant like imgIcon12 is numbered per capture, so the same name is a different file in each one
     (desktop imgIcon12 was a LinkedIn logo, tablet imgIcon12 a document icon). Files are named by where
     they are used instead: the section, then the first ancestor whose name says what it is. */
  const GENERIC = /^(icon|frame|vector|image|img|div|svg|group|text-container|content|actions|global-wrapper|section-container|.*-wrapper|.*-container|layer.*)$/i;
  const usageName = (n) => {
    const names = [n, ...ancestors(n)].map((a) => a.name).filter((x) => x && !/\s--\s|\[(desktop|tablet|mobile)\]/i.test(x));
    const section = names.find((x) => /-section$/i.test(x))?.replace(/-section$/i, "");
    const role = names.find((x) => !GENERIC.test(x) && !/-section$/i.test(x));
    const roleSlug = role ? slug(role) : "";
    return slug([section, section && roleSlug.startsWith(slug(section)) ? roleSlug.slice(slug(section).length) : roleSlug].filter(Boolean).join("-")) || (section ? slug(`${section}-background`) : "");
  };
  for (const c of caps) {
    const consts = new Map([...c.text.matchAll(/const\s+(\w+)\s*=\s*"(http:\/\/localhost:3845\/assets\/([0-9a-f]+)\.(\w+))";/g)].map((m) => [m[1], { url: m[2], hash: m[3], ext: m[4] }]));
    for (const [constName, a] of consts) {
      const entry = assets.get(a.hash) ?? { ...a, consts: new Set(), users: new Set(), usage: new Set(), files: new Set() };
      entry.consts.add(constName);
      entry.files.add(c.label);
      for (const n of c.nodes) {
        if (!n.attrs.src || !new RegExp(`\\b${constName}\\b`).test(n.attrs.src)) continue;
        entry.users.add(nameOf(n));
        const u = usageName(n);
        if (u) entry.usage.add(u);
      }
      assets.set(a.hash, entry);
    }
  }
  if (assets.size) {
    const page = caps[0].page;
    console.log(`\nASSETS (${assets.size} distinct; the script makes no network request — run these while Figma desktop is open):`);
    const lines = [];
    for (const a of assets.values()) {
      const base = [...a.usage][0] || slug([...a.consts][0].replace(/^img/, "")) || "asset";
      /* The same use at another breakpoint gets -tablet / -mobile; a second asset in the same use gets -2, -3. */
      const bp = [...a.files].every((f) => /tablet$/i.test(f)) ? "tablet" : [...a.files].every((f) => /mobile$/i.test(f)) ? "mobile" : null;
      let name = base;
      if (taken.has(name) && bp) name = `${base}-${bp}`;
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
      taken.add(name);
      lines.push(`curl -o src/assets/${page}/${name}.${a.ext} ${a.url}`);
      console.log(`  ${`${name}.${a.ext}`.padEnd(30)} ${[...a.users].slice(0, 3).join(", ") || "(unused)"}  [${[...a.files].join(", ")}]`);
    }
    console.log(`\n  mkdir -p src/assets/${page}`);
    for (const l of lines) console.log(`  ${l}`);
    console.log("  Photos: downscale to about twice the displayed size before committing. SVG icons: rebuild them with fill=\"currentColor\" so they follow the text colour and the theme.");
  }

  /* ---- fixed or clipped nodes ---- */
  const clipped = [];
  for (const c of caps) {
    for (const n of c.nodes) {
      const flags = [];
      const hasText = descendants(n).some((d) => d.text);
      const clip = n.cls.find((x) => /^overflow-(hidden|clip)$/.test(x));
      const imageCrop = descendants(n).length > 0 && descendants(n).every((d) => d.tag === "img" || d.tag === "div") && !hasText;
      if (clip && hasText) flags.push(clip);
      if (clip && !hasText && !imageCrop) flags.push(clip);
      if (n.cls.includes("text-ellipsis")) flags.push("text-ellipsis");
      const clamp = n.cls.find((x) => x.startsWith("line-clamp-"));
      if (clamp) flags.push(clamp);
      const h = clsMatch(n, /^h-\[(\d+(?:\.\d+)?)px\]$/)?.[1];
      if (h && hasText) flags.push(`h-[${h}px]${n.depth <= 3 ? " (section level)" : ""}`);
      if (flags.length) clipped.push({ where: `${c.label}: ${n.name ?? n.tag} (${n.id ?? "no id"})`, flags: flags.join(", ") });
    }
  }
  if (clipped.length) {
    console.log("\nFIXED HEIGHT / CLIPPED IN FIGMA (these cause false mismatches when the content is longer or shorter than the drawing):");
    for (const x of clipped) console.log(`  - ${x.where}: ${x.flags}`);
    out.asks.push(`${clipped.length} node(s) have a fixed height or are clipped in Figma (${[...new Set(clipped.map((x) => x.flags.split(",")[0].replace(/\s*\(.*$/, "")))].join(", ")}). Is that intentional, or should the page let them grow?`);
  }
}

/** A short key=value description of a node's box, spacing and look, from its classes. */
function describeNode(n, styles) {
  const bits = [];
  let dir = null;
  for (const c of n.cls) {
    let m;
    if ((m = c.match(/^(max-w|max-h|min-w|min-h|w|h)-\[(.+)\]$/))) bits.push(`${m[1]}${m[2].replace(/px$/, "")}`);
    else if (c === "w-full") bits.push("w100%");
    else if (c === "h-full") bits.push("h100%");
    else if ((m = c.match(/^size-\[(.+)\]$/))) bits.push(`size${m[1].replace(/px$/, "")}`);
    else if (c === "flex-col") dir = "col";
    else if (c === "flex") dir ??= "row";
    else if (c.startsWith("flex-[1_0_0]")) bits.push("grow");
    else if ((m = c.match(/^(gap(?:-[xy])?)-\[(.+)\]$/))) bits.push(`${m[1]}=${shortValue(m[2])}`);
    else if ((m = c.match(/^(p|px|py|pt|pb|pl|pr)-\[(.+)\]$/))) bits.push(`${m[1]}=${shortValue(m[2])}`);
    else if ((m = c.match(/^rounded-\[(.+)\]$/))) bits.push(`r=${shortValue(m[1])}`);
    else if ((m = c.match(/^bg-\[(var\(.+\))\]$/))) bits.push(`bg=${colorLabel(colorFrom(m[1]))}`);
    else if ((m = c.match(/^border-\[(var\(.+\))\]$/))) bits.push(`border-color=${colorLabel(colorFrom(m[1]))}`);
    else if (/^border(-[tblr])?$/.test(c)) bits.push(c);
    else if (/^border-(dashed|dotted)$/.test(c)) bits.push(c);
    else if (c.startsWith("shadow-[")) bits.push("shadow");
    else if (/^overflow-(hidden|clip)$/.test(c)) bits.push("clip");
    else if (c === "text-ellipsis" || c.startsWith("line-clamp-")) bits.push(c);
  }
  const t = n.text ? textOf(n) : null;
  if (t) {
    const style = styles.fonts.find((f) => f.size.toLowerCase() === t.sizeVar.toLowerCase() && f.weight === t.weight);
    const parts = ["text", t.sizeVar.replace(/^font-size\//, ""), t.weightName];
    if (t.lh) parts.push(t.lh.replace(/^line-height\//, "lh "));
    if (style?.letter !== undefined) parts.push(`ls=${+(style.letter / 100).toFixed(4)}em`);
    if (t.color) parts.push(`color=${colorLabel(t.color)}`);
    if (t.transform !== "none") parts.push(t.transform);
    bits.push(parts.join(" "));
  }
  if (n.tag === "img") bits.push(`src=${n.attrs.src}`);
  if (n.text) bits.push(`"${n.text.length > 40 ? `${n.text.slice(0, 40)}…` : n.text}"`);
  return `${dir ? `${dir} ` : ""}${bits.join(" ")}`.trim();
}

/** `--summary`: the capture as an indented outline, one line per node, no code. */
function runSummary(files) {
  for (const file of files) {
    const cap = readCapture(file);
    console.log(`# ${file}  (${cap.nodes.length} nodes)`);
    for (const root of cap.roots) {
      console.log(`## ${root.fn ?? "(top level)"}`);
      const walk = (n, depth) => {
        console.log(`${"  ".repeat(depth)}${n.name ?? n.tag}  ${describeNode(n, cap.styles)}`.trimEnd());
        for (const c of n.children) walk(c, depth + 1);
      };
      walk(root, 0);
    }
    console.log("");
  }
}

/* ---------- Figma metadata: layout slicing ---------- */

function runMetadata(metadataFiles) {
  const wrapperIds = (flag("wrapper") ?? "").split(",").filter(Boolean);
  const same = (a, b) => Math.abs(a - b) <= 1; // metadata positions are rounded
  const round2 = (n) => +n.toFixed(2);
  const bpOfWidth = (w) => (w >= 992 ? "desktop" : w >= 768 ? "tablet" : "mobile");
  const bpHint = (name) => name.match(/\[(desktop|tablet|mobile)\]/i)?.[1].toLowerCase();
  const cell = (v) => (v === undefined ? "—" : String(v));
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&(?:#39|apos);/g, "'").replace(/&amp;/g, "&");

  /* The text layers here are named after their style; that is how a page's type styles are found. */
  const TYPE_STYLES = {
    h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6", display: "display",
    p__lg: "text-large", p__md: "text-main", p__sm: "text-small", p__xs: "text-xsmall",
    overline__md: "overline-main", overline__sm: "overline-small",
  };

  /** A tolerant reader for get_metadata's flat tag format. Positions are relative to the parent. */
  function parseMetadata(xml, file) {
    const root = { children: [] };
    const stack = [root];
    for (const m of xml.matchAll(/<(\/?)([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g)) {
      if (m[1]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const a = Object.fromEntries([...m[3].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
      const node = {
        tag: m[2], id: a.id, name: a.name ?? "",
        x: Number(a.x ?? 0), y: Number(a.y ?? 0), w: Number(a.width), h: Number(a.height),
        children: [],
      };
      stack.at(-1).children.push(node);
      if (!m[4]) stack.push(node);
    }
    if (!root.children.length) fail(`${file}: no nodes found — expected get_metadata XML`);
    return root.children;
  }

  /** A node by id, with its offset from the section it is found under. */
  function findNode(node, id, ox = 0, oy = 0) {
    for (const c of node.children) {
      if (c.id === id) return { node: c, ox: ox + c.x, oy: oy + c.y };
      const hit = findNode(c, id, ox + c.x, oy + c.y);
      if (hit) return hit;
    }
    return null;
  }

  /** The content container: the first inset, symmetric frame under a chain of single full-width frames. */
  function findContainer(section, start) {
    let node = start?.node ?? section;
    let ox = start?.ox ?? 0;
    let oy = start?.oy ?? 0;
    for (;;) {
      const kids = node.children.filter((c) => c.tag === "frame");
      const inset = kids.filter((c) => c.w < section.w - 1 && c.x + ox > 0);
      const symmetric = inset.find((c) => same(c.x + ox, section.w - (c.x + ox) - c.w));
      if (symmetric) return { node: symmetric, x: symmetric.x + ox, y: symmetric.y + oy };
      const full = kids.filter((c) => same(c.w, section.w));
      if (full.length > 1) return { error: "several full-width children, pass --wrapper <nodeId>" };
      if (full.length === 1) {
        node = full[0];
        ox += node.x;
        oy += node.y;
        continue;
      }
      if (inset.length) {
        const c = inset[0];
        const right = round2(section.w - (c.x + ox) - c.w);
        return { node: c, x: c.x + ox, y: c.y + oy, asymmetric: `left ${c.x + ox}, right ${right}` };
      }
      return { error: "no inset container found" };
    }
  }

  const lines = (items, key) => {
    const out = [];
    for (const k of items) {
      const l = out.find((l) => same(l[0][key], k[key]));
      if (l) l.push(k);
      else out.push([k]);
    }
    return out;
  };

  /** Gaps between equal-sized siblings that span at least half the container: columns first, stacks as the fallback. */
  function collectGaps(node, span, out, where) {
    const kids = node.children.filter((c) => c.tag !== "text");
    const clusters = [];
    for (const k of kids) {
      const c = clusters.find((cl) => same(cl[0].w, k.w) && same(cl[0].h, k.h));
      if (c) c.push(k);
      else clusters.push([k]);
    }
    for (const cl of clusters.filter((c) => c.length > 1)) {
      for (const row of lines(cl, "y")) {
        row.sort((a, b) => a.x - b.x);
        if (row.length < 2 || row.at(-1).x + row.at(-1).w - row[0].x < span / 2) continue;
        row.slice(1).forEach((k, i) => {
          const gap = round2(k.x - (row[i].x + row[i].w));
          if (gap > 0) out.row.push({ value: gap, ...where });
        });
      }
      for (const col of lines(cl, "x")) {
        col.sort((a, b) => a.y - b.y);
        if (col.length < 2 || col[0].w < span / 2) continue;
        col.slice(1).forEach((k, i) => {
          const gap = round2(k.y - (col[i].y + col[i].h));
          if (gap > 0) out.stack.push({ value: gap, ...where });
        });
      }
    }
    for (const k of kids) collectGaps(k, span, out, where);
  }

  function collectTexts(node, out) {
    for (const c of node.children) {
      if (c.tag === "text" && TYPE_STYLES[c.name.toLowerCase()]) out.push({ style: c.name.toLowerCase(), w: c.w });
      collectTexts(c, out);
    }
  }

  /** Every direct child of a page frame, measured if it is a full-width frame with a findable container. */
  function measurePage(page) {
    const sections = [];
    const gaps = { row: [], stack: [] };
    for (const child of page.children) {
      const info = { node: child };
      if (child.tag !== "frame") info.reason = `${child.tag}`;
      else if (!same(child.w, page.w)) info.reason = "not full width";
      else if (!child.children.length) info.reason = "no children";
      else {
        const start = wrapperIds.map((id) => findNode(child, id)).find(Boolean);
        const hit = findContainer(child, start);
        if (hit.error) {
          info.reason = hit.error;
        } else {
          const c = hit.node;
          Object.assign(info, {
            margin: round2(hit.x),
            top: round2(hit.y),
            bottom: round2(child.h - (hit.y + c.h)),
            asymmetric: hit.asymmetric,
            containerId: c.id,
          });
          collectGaps(c, c.w, gaps, { section: child.name, id: c.id });
        }
      }
      sections.push(info);
    }
    const texts = [];
    collectTexts(page, texts);
    return { page, sections, gaps, texts };
  }

  const pageGroups = [];
  const problems = [];
  for (const file of metadataFiles) {
    for (const root of parseMetadata(readFileSync(file, "utf8"), file)) {
      const frames = root.tag === "section" ? root.children.filter((c) => c.tag === "frame") : [root];
      const byWidth = {};
      for (const f of frames) (byWidth[bpOfWidth(f.w)] ??= []).push(f);
      let chosen = BPS.every((b) => byWidth[b]?.length === 1) && frames.length === 3
        ? Object.fromEntries(BPS.map((b) => [b, byWidth[b][0]]))
        : null;
      let via = "width";
      if (!chosen && frames.length === 3) {
        const hinted = Object.fromEntries(frames.map((f) => [bpHint(f.name), f]));
        if (BPS.every((b) => hinted[b])) {
          chosen = Object.fromEntries(BPS.map((b) => [b, hinted[b]]));
          via = "name, because the widths do not split three ways";
        }
      }
      if (!chosen) {
        problems.push(`${file}: "${root.name}" has ${frames.length} frame(s) (widths ${frames.map((f) => f.w).join(", ") || "none"}); expected one per breakpoint, so it was not measured.`);
        continue;
      }
      const measured = Object.fromEntries(BPS.map((b) => [b, measurePage(chosen[b])]));
      pageGroups.push({ file, name: root.name, measured, via });
    }
  }
  if (!pageGroups.length) fail(problems.join("\n") || "nothing to measure");

  const obs = { margin: {}, top: {}, bottom: {}, gutter: {} };
  const stackedAt = new Set();
  const texts = {};
  const unmeasurable = new Map();
  const groups = new Map();
  const incomplete = [];
  let pairedByName = false;
  for (const g of pageGroups) {
    for (const b of BPS) {
      const m = g.measured[b];
      const at = (o) => (o[b] ??= []);
      for (const s of m.sections) {
        if (s.margin === undefined) {
          const key = `${g.name}|${s.node.name}|${s.reason}`;
          unmeasurable.set(key, [...(unmeasurable.get(key) ?? []), b]);
          continue;
        }
        const where = { file: g.file, page: g.name, section: s.node.name, id: s.containerId };
        at(obs.margin).push({ value: s.margin, ...where, note: s.asymmetric });
        at(obs.top).push({ value: s.top, ...where });
        at(obs.bottom).push({ value: s.bottom, ...where });
      }
      const useStack = !m.gaps.row.length && m.gaps.stack.length;
      if (useStack) stackedAt.add(b);
      for (const o of useStack ? m.gaps.stack : m.gaps.row) at(obs.gutter).push({ ...o, page: g.name });
      for (const t of m.texts) {
        const e = ((texts[t.style] ??= {})[b] ??= { n: 0, widths: new Set() });
        e.n++;
        e.widths.add(t.w);
      }
    }

    const lists = Object.fromEntries(BPS.map((b) => [b, g.measured[b].sections]));
    const counts = BPS.map((b) => lists[b].length);
    const byIndex = counts.every((c) => c === counts[0]);
    if (!byIndex) pairedByName = true;
    for (const [i, d] of lists.desktop.entries()) {
      const trio = Object.fromEntries(BPS.map((b) => [b, byIndex ? lists[b][i] : lists[b].find((s) => s.node.name === d.node.name)]));
      const done = BPS.filter((b) => trio[b]?.margin !== undefined);
      if (!done.length) continue;
      if (done.length < 3) {
        incomplete.push(`${g.name}: ${d.node.name} measured only at ${done.join("/")}`);
        continue;
      }
      const val = (s) => (s.top === s.bottom ? s.top : `${s.top}/${s.bottom}`);
      const key = BPS.map((b) => val(trio[b])).join("|");
      const entry = groups.get(key) ?? { values: Object.fromEntries(BPS.map((b) => [b, val(trio[b])])), sections: [] };
      entry.sections.push(`${g.name.replace(/^.*?--\s*V\d+\s*--\s*/, "")}: ${d.node.name}`);
      groups.set(key, entry);
    }
  }

  /** Modal value of a measurement, the distinct values with counts, and every observation that disagrees. */
  function modal(list = []) {
    const counts = new Map();
    for (const o of list) counts.set(o.value, (counts.get(o.value) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (!sorted.length) return null;
    return {
      value: sorted[0][0],
      count: sorted[0][1],
      total: list.length,
      distinct: sorted,
      tie: sorted.length > 1 && sorted[1][1] === sorted[0][1],
      outliers: list.filter((o) => o.value !== sorted[0][0]),
    };
  }
  const measures = {
    "site-margin": Object.fromEntries(BPS.map((b) => [b, modal(obs.margin[b])])),
    "section padding top": Object.fromEntries(BPS.map((b) => [b, modal(obs.top[b])])),
    "section padding bottom": Object.fromEntries(BPS.map((b) => [b, modal(obs.bottom[b])])),
    "site-gutter": Object.fromEntries(BPS.map((b) => [b, modal(obs.gutter[b])])),
  };

  const confidence = (name, m) => {
    const parts = BPS.map((b) => {
      const x = m[b];
      if (!x) return "none";
      if (name === "site-gutter" && stackedAt.has(b)) return "low (from stacked layout)";
      if (x.tie) return "low (tie)";
      if (x.distinct.length > 1) return `medium (${x.outliers.length} outlier)`;
      return x.total >= 3 ? "high" : "medium (few samples)";
    });
    return parts.every((p) => p === parts[0]) ? parts[0] : BPS.map((b, i) => `${b[0].toUpperCase()}: ${parts[i]}`).join("; ");
  };

  console.log("PAGES");
  for (const g of pageGroups) {
    const parts = BPS.map((b) => `${b} ${g.measured[b].page.w}px (${g.measured[b].sections.filter((s) => s.margin !== undefined).length} of ${g.measured[b].sections.length} measurable)`);
    console.log(`  ${g.name}: ${parts.join(", ")}${g.via === "width" ? "" : ` — frames told apart by ${g.via}`}`);
  }
  for (const p of problems) console.log(`  ! ${p}`);
  if (pairedByName) console.log("  note: the frames have different child counts, so sections were paired by name.");

  console.log("\nnote: metadata cannot tell a fixed-height frame from a content-sized one; the FIXED HEIGHT / CLIPPED list of --design-context does.");
  console.log("\nMEASURED");
  printTable(
    ["MEASURE", "MOBILE", "TABLET", "DESKTOP", "COUNT M/T/D", "CONFIDENCE"],
    Object.entries(measures).map(([name, m]) => [
      name,
      ...["mobile", "tablet", "desktop"].map((b) => cell(m[b]?.value)),
      ["mobile", "tablet", "desktop"].map((b) => (m[b] ? `${m[b].count}/${m[b].total}` : "0")).join(" "),
      confidence(name, m),
    ]),
  );

  const spread = [];
  for (const [name, m] of Object.entries(measures)) {
    for (const b of ["mobile", "tablet", "desktop"]) {
      const x = m[b];
      if (!x || x.distinct.length === 1) continue;
      spread.push(`${name} at ${b}: ${x.distinct.map(([v, c]) => `${v}×${c}`).join(", ")}`);
      for (const o of x.outliers.slice(0, 5)) {
        spread.push(`  outlier ${o.value} — ${o.page ?? ""}${o.section ? `, ${o.section}` : ""}${o.id ? ` (${o.id})` : ""}${o.note ? ` [asymmetric: ${o.note}]` : ""}`);
      }
    }
  }
  if (spread.length) {
    console.log("\nDISTINCT VALUES (modal first):");
    for (const l of spread) console.log(`  ${l}`);
  }
  const asym = Object.values(obs.margin).flat().filter((o) => o.note && !spread.some((l) => l.includes(`(${o.id})`)));
  for (const o of asym) console.log(`  asymmetric container in ${o.page}, ${o.section} (${o.id}): ${o.note}`);

  const groupList = [...groups.values()];
  console.log("\nSECTION PADDING GROUPS (container y, and section height minus container bottom):");
  if (!groupList.length) console.log("  none measured at all three breakpoints");
  for (const [i, gr] of groupList.entries()) {
    const v = gr.values;
    console.log(`  G${i + 1}  M${v.mobile} T${v.tablet} D${v.desktop} — ${gr.sections.length} section(s), ${gr.sections.length * 3} measurements: ${gr.sections.join("; ")}`);
  }
  for (const l of incomplete) console.log(`  incomplete: ${l}`);

  if (unmeasurable.size) {
    console.log("\nNOT MEASURABLE FROM METADATA:");
    for (const [key, bps] of unmeasurable) {
      const [page, name, reason] = key.split("|");
      console.log(`  ${page.replace(/^.*?--\s*V\d+\s*--\s*/, "")}: ${name} (${reason}) at ${[...new Set(bps)].join("/")}`);
    }
  }

  /* ---- compare with base.css ---- */
  const have = (m) => Object.fromEntries(BPS.filter((b) => m[b]).map((b) => [b, m[b].value]));
  const cmpRows = [];
  const toUpdate = [];
  const asks = [];
  for (const token of ["site-margin", "site-gutter"]) {
    const measured = have(measures[token]);
    if (!Object.keys(measured).length) continue;
    const { status, cur } = compareLayout(token, measured);
    cmpRows.push([`--${token}`, fmt(measured), cur ? fmt(cur) : "—", status]);
    if (status === "DIFFERS") {
      toUpdate.push(...triple(token, { ...cur, ...measured }));
      asks.push(`--${token} is ${fmt(cur)} in base.css but the frames measure ${fmt(measured)}. Change the token, or is the design inconsistent?`);
    }
  }

  const symmetric = groupList.filter((gr) => BPS.every((b) => typeof gr.values[b] === "number"));
  const sectionTokens = Object.keys(tokens.scale).filter((n) => n.startsWith("section-space-"));
  for (const t of sectionTokens) {
    const hit = symmetric.find((gr) => compareLayout(t, gr.values).status === "MATCH");
    cmpRows.push([`--${t}`, hit ? fmt(hit.values) : "—", fmt(tokens.scale[t]), hit ? `MATCH (G${groupList.indexOf(hit) + 1})` : "UNMAPPED"]);
  }
  console.log("\nCOMPARED WITH base.css (D = desktop, T = tablet, M = mobile):");
  printTable(["TOKEN", "MEASURED", "BASE.CSS", "STATUS"], cmpRows);

  for (const [i, gr] of groupList.entries()) {
    const v = gr.values;
    const label = `G${i + 1} (${v.mobile}/${v.tablet}/${v.desktop} mobile/tablet/desktop)`;
    if (!symmetric.includes(gr)) {
      asks.push(`${label}: top and bottom padding differ. Is that deliberate, and which section-space token does it belong to?`);
      continue;
    }
    const tokenHits = sectionTokens.filter((t) => compareLayout(t, gr.values).status === "MATCH");
    if (tokenHits.length) {
      asks.push(`${label} equals ${tokenHits.map((t) => `--${t}`).join(", ")}. ASK: which token is ${v.desktop}/${v.tablet}/${v.mobile} (small/medium/large/nav-overlap)? Section default prop is medium.`);
    } else {
      const near = nearest(v, tokens.scale, (n) => n.startsWith("section-space-"));
      asks.push(`${label} matches no section-space token${near ? ` (nearest --${near.name}, ${fmt(near)}, off by ${near.delta}px)` : ""}. ASK: which token is it (small/medium/large/nav-overlap), or a new one? Section default prop is medium.`);
    }
  }
  if (groupList.length > 1) {
    asks.push(`The section padding differs between sections (${groupList.length} groups). ASK: are they variants (e.g. small/large)? Settle that before mapping any of them.`);
  }
  for (const t of sectionTokens) {
    if (!symmetric.some((gr) => compareLayout(t, gr.values).status === "MATCH")) {
      asks.push(`--${t} (${fmt(tokens.scale[t])}) has no measured counterpart in these frames. ASK: does a variant use it?`);
    }
  }

  console.log(texts.display
    ? "\ndisplay: used by text layers in these frames (measure its size with get_design_context)."
    : "\ndisplay: not used in these frames.");

  console.log("\nTYPE STYLES USED (layer names; metadata has no sizes):");
  const styleRows = Object.keys(texts).sort().map((s) => [
    s,
    `--${TYPE_STYLES[s]}`,
    ...["mobile", "tablet", "desktop"].map((b) => {
      const e = texts[s][b];
      if (!e) return "—";
      const widths = [...e.widths].sort((a, c) => a - c);
      return `${e.n}× w${widths.length > 3 ? `${widths[0]}–${widths.at(-1)}` : widths.join("/")}`;
    }),
  ]);
  if (styleRows.length) printTable(["STYLE", "TOKEN", "MOBILE", "TABLET", "DESKTOP"], styleRows);
  else console.log("  no text layers named after a type style");

  const layoutEntry = (token, m) => `    { "token": "${token}", "px": { "desktop": ${m.desktop}, "tablet": ${m.tablet}, "mobile": ${m.mobile} } }`;
  const snippet = ["site-margin", "site-gutter"]
    .map((t) => [t, have(measures[t])])
    .filter(([, m]) => BPS.every((b) => m[b] !== undefined))
    .map(([t, m]) => layoutEntry(t, m));
  console.log("\nLAYOUT JSON (for --json; section-space groups wait for the answer below):");
  console.log(`{\n  "layout": [\n${snippet.join(",\n")}\n  ]\n}`);
  for (const [i, gr] of groupList.entries()) {
    const v = gr.values;
    if (symmetric.includes(gr)) console.log(`  G${i + 1}: { "token": "section-space-<chosen>", "px": { "desktop": ${v.desktop}, "tablet": ${v.tablet}, "mobile": ${v.mobile} } }`);
  }

  out.asks.push(...asks);
  out.updates.push(...toUpdate);
}

/* ---------- batch: the shape Claude fills in from the Figma file ---------- */

function runInventory(jsonPath) {
  const design = JSON.parse(readFileSync(jsonPath, "utf8"));

  const unknown = Object.keys(design).filter((k) => !INVENTORY_KEYS.includes(k));
  if (unknown.length) {
    fail(`unknown key(s): ${unknown.join(", ")}. Expected any of: ${INVENTORY_KEYS.join(", ")}`);
  }
  if (!INVENTORY_KEYS.some((k) => (design[k] ?? []).length)) {
    fail("nothing to convert — every list is empty or missing.");
  }
  const rows = [];
  const additions = [];
  const questions = [];
  const contrastRows = [];
  const updates = [];
  const guesses = [];

  const noteGuess = (name, d) => {
    if (d.missing.length) guesses.push(`--${name}: ${d.missing.join(", ")} guessed from --${d.ref} (${d.ratios.join(", ")}).`);
  };

  /** What is said about the breakpoints a token fills in because the design did not measure them. */
  const inherited = (values, near) => {
    const missing = BPS.filter((b) => values[b] === undefined);
    return missing.length ? ` — ${missing.join("/")} from the token (${fmt(near)})` : "";
  };

  /** space, radius and icon: one px (desktop) or a value per breakpoint, snapped to the scale. */
  function matchScale(item, filter, prefix) {
    const values = perBp(item.px, item.name);
    const from = fmt(values);
    const near = nearest(values, tokens.scale, filter);
    if (near && near.delta === 0) {
      rows.push([item.name, from, `--${near.name}`, `exact${inherited(values, near)}`]);
    } else if (near && near.delta <= SNAP_PX) {
      rows.push([item.name, from, `--${near.name}`, `snapped, off by ${near.delta}px${inherited(values, near)}${tieNote(near) && `; ${tieNote(near)}`}`]);
    } else {
      const d = deriveMissing(values, tokens.scale, filter);
      const name = item.token ?? `${prefix}-${slug(item.name)}`;
      additions.push({ name, values: d.values });
      noteGuess(name, d);
      rows.push([item.name, from, `--${name}`, `NEW — ${d.missing.length ? `${d.missing.join("/")} guessed from --${d.ref}` : "all breakpoints measured"}`]);
      questions.push(`--${name}: ${from} is ${near ? `${near.delta}px off --${near.name} (${fmt(near)})` : "unmatched"}. New token, or consolidate?${tieNote(near) && ` (${tieNote(near)})`}`);
    }
  }

  /** site-margin, site-gutter, display and section-space-*: one px (desktop) or a value per breakpoint. */
  function matchLayout(item) {
    if (!isLayoutToken(item.token ?? "")) {
      fail(`layout: token must be site-margin, site-gutter, display or section-space-*, got ${JSON.stringify(item.token)}`);
    }
    const values = perBp(item.px, item.token);
    const from = fmt(values);
    const label = item.name ?? item.token;
    const { status, cur } = compareLayout(item.token, values);
    if (status === "MATCH") {
      rows.push([label, from, `--${item.token}`, `match${inherited(values, cur)}`]);
    } else if (status === "DIFFERS") {
      rows.push([label, from, `--${item.token}`, `DIFFERS — base.css has ${fmt(cur)}${inherited(values, cur)}`]);
      updates.push(...triple(item.token, { ...cur, ...values }));
      questions.push(`--${item.token} is ${fmt(cur)} in base.css but the design measures ${from}. Change the token, or is the design inconsistent?`);
    } else {
      const d = deriveMissing(values, tokens.scale, layoutFamily(item.token));
      rows.push([label, from, `--${item.token}`, "UNMAPPED — not in base.css"]);
      if (BPS.some((b) => d.values[b] === undefined)) {
        questions.push(`--${item.token} is not in base.css and only ${from} was measured. Measure the other breakpoints before adding it.`);
      } else {
        additions.push({ name: item.token, values: d.values });
        noteGuess(item.token, d);
        questions.push(`--${item.token} is not in base.css (${from}). Add it?`);
      }
    }
  }

  for (const item of design.space ?? []) matchScale(item, isSpace, "space");

  /** letterPx / letterPct on a type entry, as em at each measured breakpoint. */
  function letterEm(item, size) {
    if (item.letterPx !== undefined && item.letterPct !== undefined) fail(`${item.name}: give letterPx or letterPct, not both`);
    const raw = perBp(item.letterPx ?? item.letterPct, `${item.name} letter spacing`);
    const em = {};
    for (const b of BPS.filter((k) => raw[k] !== undefined)) {
      if (item.letterPct !== undefined) em[b] = raw[b] / 100;
      else if (size[b] !== undefined) em[b] = raw[b] / size[b];
      else fail(`${item.name}: letterPx at ${b} needs sizePx at ${b} to divide by`);
      em[b] = +em[b].toFixed(4);
    }
    return em;
  }

  /** Letter spacing is one value per style in base.css, not one per breakpoint. */
  function matchLetter(item, size, style, name) {
    if (item.letterPx === undefined && item.letterPct === undefined) return;
    const em = letterEm(item, size);
    const label = `${item.name} letter-spacing`;
    const from = `${BPS.filter((b) => em[b] !== undefined).map((b) => `${b[0].toUpperCase()}${em[b]}`).join(" ")} em`;
    const all = Object.values(em);
    const styleToken = `${style ?? name}-letter-spacing`;
    if (Math.max(...all) - Math.min(...all) > LETTER_EPS) {
      rows.push([label, from, `--${styleToken}`, "DIFFERS by breakpoint — not applied"]);
      questions.push(`${item.name} letter spacing is ${from}; this system has one value per style. Which one, or is the design inconsistent?`);
      return;
    }
    const value = +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(4);
    const target = nearestValue(value, tokens.letterSpacing);
    let ref = target?.name;
    if (!target || target.delta > LETTER_EPS) {
      const tokenName = `letter-spacing-${slug(item.name)}`;
      additions.push({ name: tokenName, value: `${value}em` });
      ref = `--${tokenName}`;
    }
    const current = style ? tokens.styleLetter[style] : null;
    if (current && Math.abs(current.em - value) <= LETTER_EPS) {
      rows.push([label, from, `--${styleToken}`, `match (${current.token ? `var(${current.token}) = ` : ""}${current.em}em)`]);
      return;
    }
    const line = `--${styleToken}: var(${ref});`;
    if (style) {
      rows.push([label, from, `--${styleToken}`, `CHANGE${current ? ` from ${current.em}em` : ""} — ${line}`]);
      updates.push(line);
    } else {
      rows.push([label, from, `--${styleToken}`, `NEW — set on the new style: ${line}`]);
      additions.push({ name: styleToken, value: `var(${ref})` });
    }
  }

  for (const item of design.type ?? []) {
    const size = perBp(item.sizePx, item.name);
    const near = nearest(size, tokens.scale, isType);
    const matched = near && near.delta <= SNAP_PX;
    const sizeNote = !matched ? "NEW" : near.delta === 0 ? "exact" : `snapped, off by ${near.delta}px`;
    const name = item.token ?? slug(item.name);
    if (matched) {
      rows.push([item.name, fmt(size), `--${near.name}`, `${sizeNote}${inherited(size, near)}`]);
    } else {
      const d = deriveMissing(size, tokens.scale, isType);
      additions.push({ name, values: d.values });
      noteGuess(name, d);
      rows.push([item.name, fmt(size), `--${name}`, `NEW — ${d.missing.length ? `${d.missing.join("/")} guessed from --${d.ref}` : "all breakpoints measured"}`]);
      questions.push(`${item.name} at ${fmt(size)} is unmatched${near ? ` (nearest --${near.name}, ${fmt(near)})` : ""}. New size, or consolidate?${tieNote(near) && ` (${tieNote(near)})`}`);
    }

    matchLetter(item, size, matched ? near.name : null, name);

    if (item.lineHeightPx === undefined) continue;
    const lh = perBp(item.lineHeightPx, `${item.name} line height`);
    const ownName = matched ? `${near.name}-line-height` : null;
    const own = ownName && tokens.scale[ownName] ? nearest(lh, { [ownName]: tokens.scale[ownName] }) : null;
    /* A matched size keeps its own line height; only an unmatched one looks across all of them. */
    const lhNear = own ?? nearest(lh, tokens.scale, isLineHeight);
    const from = fmt(lh);
    if (lhNear && lhNear.delta <= SNAP_PX) {
      const note = lhNear.delta === 0 ? "exact" : `snapped, off by ${lhNear.delta}px`;
      rows.push([`${item.name} line-height`, from, `--${lhNear.name}`, `${note}${inherited(lh, lhNear)}`]);
    } else if (own) {
      rows.push([`${item.name} line-height`, from, `--${own.name}`, `DIFFERS by ${own.delta}px — not applied`]);
      questions.push(`${item.name} line height ${from} is ${own.delta}px off --${own.name} (${fmt(own)}). Change that token, or keep it?`);
    } else {
      const lhName = `${name}-line-height`;
      const d = deriveMissing(lh, tokens.scale, isLineHeight);
      additions.push({ name: lhName, values: d.values });
      noteGuess(lhName, d);
      rows.push([`${item.name} line-height`, from, `--${lhName}`, `NEW — ${d.missing.length ? `${d.missing.join("/")} guessed from --${d.ref}` : "all breakpoints measured"}`]);
      questions.push(`${item.name} line height ${from} has no token${lhNear ? ` (nearest --${lhNear.name}, ${fmt(lhNear)})` : ""}. Add one, or use ${lhNear ? `--${lhNear.name}` : "an existing one"}?`);
    }
  }

  for (const item of design.color ?? []) {
    const alpha = item.alpha === undefined ? 100 : Math.round(item.alpha * 100);
    const { css: value, match } = toColorMix(item.hex, alpha, tokens.swatches);
    const note =
      match && match.d === 0
        ? alpha < 100 ? "opacity restated as a mix" : "exact swatch"
        : `NEW — nearest ${match?.name} is ${match?.d} away`;
    const asText =
      match && match.d === 0 && alpha < 100 && tokens.textSwatches.has(match.name);
    rows.push([
      item.name,
      `${item.hex}${alpha < 100 ? ` @${alpha}%` : ""}`,
      asText ? `color-mix(in lab, currentcolor ${alpha}%, transparent)` : value,
      asText ? "muted text — currentcolor, so it follows the theme" : note,
    ]);
    if (item.on) {
      const ratio = contrastRatio(item.hex, item.on, item.alpha ?? 1);
      const floor = contrastFloor(item.sizePx ?? 16, item.bold);
      contrastRows.push([
        item.name,
        `${item.hex}${alpha < 100 ? ` @${alpha}%` : ""} on ${item.on}`,
        `${ratio}:1`,
        ratio >= floor ? `passes (needs ${floor})` : `FAILS — needs ${floor}:1`,
      ]);
    }

    if (!match || match.d !== 0) {
      additions.push({ name: item.token ?? `color-${slug(item.name)}`, value });
      questions.push(`${item.name} ${item.hex} matches no swatch (nearest ${match?.name}). New color, or use the existing one?`);
    }
  }

  for (const item of design.letter ?? []) {
    const em = item.pct !== undefined
      ? +(item.pct / 100).toFixed(4)
      : +(item.px / item.sizePx).toFixed(4);
    const near = nearestValue(em, tokens.letterSpacing);
    const from = item.pct !== undefined ? `${item.pct}%` : `${item.px}/${item.sizePx}`;
    if (near && near.delta <= 0.005) {
      rows.push([item.name, from, `${em}em`, `snapped to ${near.name}`]);
    } else {
      const name = item.token ?? `letter-spacing-${slug(item.name)}`;
      additions.push({ name, value: `${em}em` });
      rows.push([item.name, from, `${em}em`, `NEW — nearest ${near?.name} is ${near?.delta.toFixed(4)} away`]);
      questions.push(`${item.name} letter-spacing ${em}em has no token. Add one, or use ${near?.name}?`);
    }
  }

  for (const item of design.radius ?? []) matchScale(item, isRadius, "radius");

  for (const item of design.icon ?? []) matchScale(item, isIcon, "icon");

  for (const item of design.layout ?? []) matchLayout(item);

  for (const item of design.weight ?? []) {
    const num = typeof item.value === "number"
      ? item.value
      : WEIGHT_NAMES[String(item.value).toLowerCase().replace(/[^a-z]/g, "")];
    if (!num) {
      rows.push([item.name, String(item.value), "?", "UNKNOWN weight name"]);
      questions.push(`${item.name}: could not read the weight "${item.value}".`);
      continue;
    }
    const near = nearestValue(num, tokens.weights);
    if (near && near.delta === 0) {
      rows.push([item.name, String(item.value), near.name, `exact (${num})`]);
    } else {
      rows.push([item.name, String(item.value), String(num), `NEW — nearest ${near?.name} is ${near?.value}`]);
      questions.push(`${item.name} is weight ${num}; the system has ${Object.values(tokens.weights).join(", ")}. Add it, or use ${near?.name}?`);
    }
  }

  console.log("D = desktop (>=992px), T = tablet (768-991px), M = mobile (<768px)\n");
  printTable(["FROM", "FIGMA", "LUMOS", "NOTE"], rows);

  if (contrastRows.length) {
    const cw = [0, 1, 2, 3].map((i) => Math.max(...contrastRows.map((r) => String(r[i]).length), 4));
    console.log("\nCONTRAST (flagged, not blocking):");
    for (const r of contrastRows) {
      console.log("  " + r.map((c, i) => String(c).padEnd(cw[i])).join("  "));
    }
  }

  out.guesses.push(...guesses);
  out.asks.push(...questions);
  out.updates.push(...updates);
  out.places.push(...additions);
}

/* ---------- run ---------- */

/** Value of --name, or the fallback when the flag has no value. */
const optionValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? fallback : next;
};

/** Every file in a folder, sorted into the mode that reads it, by what is inside it. */
function scanFolder(dir) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.toLowerCase() !== "readme.md")
      .map((e) => e.name)
      .sort();
  } catch {
    fail(`FOLDER ${dir}: cannot read the folder — does it exist?`);
  }
  const found = { variables: [], metadata: [], designs: [], inventories: [], skipped: [] };
  for (const name of names) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf8").trimStart();
    const skip = (reason) => found.skipped.push({ name, reason });
    if ((/data-node-id=/.test(text) && /className=/.test(text)) || text.includes("These styles are contained in the design")) {
      found.designs.push(path);
      continue;
    }
    if (text[0] === "{" || text[0] === "[") {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        skip(`invalid JSON (${e.message})`);
        continue;
      }
      const keys = Array.isArray(data) ? [] : Object.keys(data);
      const bad = keys.filter((k) => !INVENTORY_KEYS.includes(k));
      if (Array.isArray(data)) skip("JSON array, expected an object");
      else if (data.modes && typeof data.modes === "object" && Array.isArray(data.variables)) found.variables.push(path);
      else if (!keys.length) skip("empty JSON object");
      else if (bad.length) skip(`neither a variable export nor an inventory (unknown key(s): ${bad.join(", ")})`);
      else if (!keys.some((k) => (data[k] ?? []).length)) skip("inventory with every list empty");
      else found.inventories.push(path);
    } else if (text[0] === "<") {
      const tag = text.match(/^(?:<\?[^>]*\?>\s*)*<\s*([\w-]+)/)?.[1];
      if (["section", "frame", "canvas", "instance"].includes(tag)) found.metadata.push(path);
      else skip(`XML starting with <${tag ?? "?"}>, not get_metadata output`);
    } else {
      skip("not JSON or XML");
    }
  }
  return { ...found, count: names.length };
}

const variableList = flagAll("variables");
const metadataList = flagAll("metadata");
const designList = flagAll("design-context");
const summaryList = flagAll("summary");
const inventoryList = flagAll("json").slice(0, 1);
if (args.includes("--variables") && !variableList.length) fail("--variables needs one or more files");
if (args.includes("--metadata") && !metadataList.length) fail("--metadata needs one or more XML files");
if (args.includes("--summary") && !summaryList.length) fail("--summary needs one or more design-context files");
if (args.includes("--design-context") && !designList.length) fail("--design-context needs one or more files");
if (args.includes("--json") && !inventoryList.length) fail("--json needs a file");

if (summaryList.length) {
  runSummary(summaryList);
  process.exit(0);
}

const folder = optionValue("folder", "figma");
let folderMode = false;
let found = null;
if (folder !== undefined) {
  folderMode = true;
  found = scanFolder(folder);
  if (!found.count) fail(`FOLDER ${folder.replace(/\/$/, "")}/: no files found — drop a variable export, get_metadata XML, get_design_context output or inventory JSON there.`);
  const page = optionValue("page", undefined);
  if (page) {
    const ofPage = (p) => basename(p).toLowerCase().startsWith(page.toLowerCase());
    for (const key of ["metadata", "designs"]) {
      found.skipped.push(...found[key].filter((p) => !ofPage(p)).map((p) => ({ name: basename(p), reason: `not page "${page}" (file name must start with it)` })));
      found[key] = found[key].filter(ofPage);
    }
  }
  variableList.push(...found.variables);
  metadataList.push(...found.metadata);
  designList.push(...found.designs);
  inventoryList.push(...found.inventories);
}

if (!variableList.length && !metadataList.length && !designList.length && !inventoryList.length) {
  if (found) {
    console.error(`FOLDER ${folder.replace(/\/$/, "")}/: ${found.count} file(s), none recognised.`);
    for (const s of found.skipped) console.error(`  - ${s.name}: ${s.reason}`);
    process.exit(1);
  }
  fail("need --folder [dir], --json <file>, --variables <file...>, --metadata <file...>, --design-context <file...>, --summary <file...>, or one of --px / --lh / --color");
}

/* What every mode adds to; printed once at the end, so a folder run asks each question once. */
const out = { asks: [], guesses: [], updates: [], places: [] };
const heading = (title) => {
  if (folderMode) console.log(`\n=== ${title} ===\n`);
};

if (folderMode && (variableList.length || metadataList.length) && !designList.length) {
  out.asks.push("No get_design_context capture in this run, so weight, letter spacing and text-transform per text style, text colours, shadows, buttons, assets and fixed or clipped nodes were NOT checked. Save get_design_context output (excludeScreenshot true) for each frame into the folder and run again.");
}

printVersion();
if (found) {
  const dir = `${folder.replace(/\/$/, "")}/`;
  const listed = (label, paths) => paths.length && console.log(`  ${label}: ${paths.map((p) => p.slice(dir.length)).join(", ")}`);
  console.log(`FOLDER ${dir}: ${found.variables.length} variable export(s), ${found.metadata.length} metadata, ${found.designs.length} design context, ${found.inventories.length} inventor${found.inventories.length === 1 ? "y" : "ies"}, ${found.skipped.length} skipped`);
  listed("variable exports", found.variables);
  listed("metadata", found.metadata);
  listed("design context", found.designs);
  listed("inventories", found.inventories);
  if (found.skipped.length) {
    console.log("SKIPPED (not recognised):");
    for (const s of found.skipped) console.log(`  - ${s.name}: ${s.reason}`);
  }
}

if (variableList.length) {
  heading(`VARIABLES (${variableList.length} file(s))`);
  runVariables(variableList);
}
if (metadataList.length) {
  heading(`METADATA (${metadataList.length} file(s))`);
  runMetadata(metadataList);
}
if (designList.length) {
  heading(`DESIGN CONTEXT (${designList.length} file(s))`);
  runDesignContext(designList);
}
for (const file of inventoryList) {
  heading(`INVENTORY ${file}`);
  runInventory(file);
}

const unique = (list) => [...new Set(list)];
const guesses = unique(out.guesses);
const asks = unique(out.asks);
const updates = unique(out.updates);
const places = out.places.filter((a, i) => out.places.findIndex((b) => b.name === a.name) === i);
if (folderMode) console.log("\n=== CONSOLIDATED ===");
if (guesses.length) {
  console.log("\nGUESSES (list in the report):");
  for (const g of guesses) console.log(`  - ${g}`);
}
if (asks.length) {
  console.log("\nASK BEFORE WRITING:");
  for (const q of asks) console.log(`  - ${q}`);
}
if (updates.length) {
  console.log("\nTO UPDATE BY HAND (value differs — confirm which side is right first):");
  for (const u of updates) console.log(`  ${u}`);
}
if (places.length) {
  console.log("\nTO PLACE BY HAND (section matters — put each beside its own kind):");
  for (const a of places) printBlock(a);
}
