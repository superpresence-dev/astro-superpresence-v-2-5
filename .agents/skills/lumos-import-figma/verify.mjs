#!/usr/bin/env node
/**
 * Measures a built page in a real browser against what Figma said it should be.
 *
 * Reports only: it exits 0 whatever it finds, and non-zero only when Chrome or
 * the URL cannot be reached. Plain Node, no dependencies: Chrome is driven over
 * the DevTools protocol with Node's global WebSocket, and `sharp` (already
 * installed with astro) is used only for the optional screenshot diff.
 *
 * For each breakpoint frame found in the metadata (Desktop / Tablet / Mobile —
 * the widths come from the file, nothing is hard-coded) it sets that viewport
 * width, loads the page, waits for `load` and `document.fonts.ready`, scrolls
 * through the page once so lazy images have a size, and then reports three things.
 *
 *   SECTIONS     The Figma page frame's direct children against the DOM's page
 *                sections. They are paired by the words they share (the navbar and
 *                footer by their header/footer element), keeping page order, so a
 *                section that is not built yet does not shift every row below it.
 *                Per section: y and height on both sides, the deltas, and the
 *                running total of height deltas over the paired sections.
 *
 *                The DOM sections are the in-flow, non-zero-height children of
 *                <body>, with these wrappers replaced by their own children: <main>,
 *                `display: contents` elements (astro-island), a <div> that directly
 *                holds a <header>/<nav>/<main>/<footer>, and a <div> that is the
 *                only child at its level and holds two or more children. So
 *                `<nav> <main><section>…<section></main> <footer>` gives
 *                nav, every section, footer. Fixed and absolute elements and
 *                <script>/<style> are never sections. `--sections "<css>"` replaces
 *                the rule with a selector when it guesses wrong.
 *
 *   TEXT         Every Figma text node (metadata gives the box, the design-context
 *                capture gives the words) against the DOM element whose own text is
 *                the same words, normalised (case, whitespace, curly quotes). The
 *                element is the innermost one with that text. Inside a section, one
 *                node and one element is a match; the same words N times in Figma
 *                and N times in the DOM are paired by reading order (y, then x);
 *                any other count is ambiguous and skipped. The box compared is the
 *                content box (padding and border removed), x from the page's left
 *                edge and y from its own section's top, so one section's drift does
 *                not cascade into the next. Deltas are DOM minus Figma, in px.
 *                Text inside an instance (navbar, footer) has no box in metadata,
 *                so it is counted but not compared.
 *
 *   SCREENSHOTS  A full-page web shot is written to <folder>/shots/<page>-<bp>-web.png.
 *                If <folder>/shots/<page>-<bp>.png exists (a 1x export from Figma),
 *                the web shot is scaled to its width, a diff image is written next
 *                to it, and the mismatch is printed per section band.
 *
 *   SECTION DIFF With Figma desktop open on the file (its Dev Mode MCP server on
 *                127.0.0.1:3845), each Figma section is captured with get_screenshot
 *                and compared with its paired DOM section, cropped from the web shot
 *                at the DOM's own position, so drift above it does not shift the
 *                comparison. Writes <page>-<bp>-<nn>-<section>.png: Figma | web |
 *                diff side by side, red where they differ. Figma caps a screenshot
 *                at 1024px on its long side, so the comparison runs at that scale.
 *                `--no-figma` skips it.
 *
 * The page runs with prefers-reduced-motion: reduce so scroll-reveal transforms do
 * not move boxes, and the Astro dev toolbar is hidden.
 *
 * Usage
 *   node verify.mjs --url http://localhost:4321/ --page home [--folder figma]
 *                   [--tolerance 1] [--chrome <path>] [--sections "<css>"]
 *                   [--threshold 32]   # per-channel colour difference that counts as a mismatch
 *                   [--no-figma]       # skip fetching section screenshots from Figma desktop
 *
 * Input files (in --folder): <page>-metadata.xml and <page>-<desktop|tablet|mobile>-context.txt,
 * the same ones `convert.mjs --folder` reads.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const url = flag("url");
const page = flag("page");
if (!url || !page) fail('usage: node verify.mjs --url http://localhost:4321/ --page home [--folder figma] [--tolerance 1] [--chrome <path>] [--sections "<css>"] [--threshold 32]');
const folder = flag("folder") ?? "figma";
const tolerance = Number(flag("tolerance") ?? 1);
const pixelThreshold = Number(flag("threshold") ?? 32);
const sectionSelector = flag("sections");
const useFigma = !args.includes("--no-figma");
const FIGMA_MCP = "http://127.0.0.1:3845/mcp";
if (!Number.isFinite(tolerance) || !Number.isFinite(pixelThreshold)) fail("--tolerance and --threshold must be numbers");

/* ---------- small helpers ---------- */

const bpOfWidth = (w) => (w >= 992 ? "desktop" : w >= 768 ? "tablet" : "mobile");
const bpHint = (name) => name.match(/\[(desktop|tablet|mobile)\]/i)?.[1].toLowerCase();
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&(?:#39|apos);/g, "'").replace(/&amp;/g, "&");
const normText = (s) => s.replace(/[\u00a0\s]+/g, " ").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim().toLowerCase();
const round1 = (n) => Math.round(n * 10) / 10;
const signed = (n) => (Math.abs(n) < 0.05 ? "0" : `${n > 0 ? "+" : ""}${round1(n)}`);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const printTable = (head, body, indent = "") => {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const row = (r) => indent + r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd();
  console.log(row(head));
  console.log(indent + w.map((n) => "-".repeat(n)).join("  "));
  for (const r of body) console.log(row(r));
};


/* ---------- Figma desktop: screenshots over its Dev Mode MCP server ---------- */

/** A minimal MCP client over Streamable HTTP; null when Figma desktop is not running. */
async function figmaClient() {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const read = async (res) => {
    const text = await res.text();
    const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    return events.at(-1) ?? (text ? JSON.parse(text) : null);
  };
  let res;
  try {
    res = await fetch(FIGMA_MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lumos-verify", version: "1" } } }) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const session = res.headers.get("mcp-session-id");
  await read(res);
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}) };
  await fetch(FIGMA_MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  let id = 2;
  return {
    /** PNG bytes of a node, or null with the reason. */
    async screenshot(nodeId) {
      const r = await fetch(FIGMA_MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "get_screenshot", arguments: { nodeId } } }) });
      const msg = await read(r);
      const img = msg?.result?.content?.find((c) => c.type === "image");
      if (img) return { png: Buffer.from(img.data, "base64") };
      return { error: msg?.result?.content?.find((c) => c.type === "text")?.text ?? msg?.error?.message ?? "no image" };
    },
  };
}

/** Figma | web | diff for one section, and the share of pixels that differ. */
async function sectionDiff(sharp, figmaPng, webPng, dom, outPng) {
  const fig = sharp(figmaPng).flatten({ background: "#ffffff" }).removeAlpha();
  const { width: fw, height: fh } = await fig.metadata();
  const web = await sharp(webPng);
  const meta = await web.metadata();
  const top = Math.max(0, Math.round(dom.y));
  const h = Math.max(1, Math.min(Math.round(dom.h), meta.height - top));
  const crop = await sharp(webPng).extract({ left: 0, top, width: meta.width, height: h }).resize({ width: fw, height: fh, fit: "fill" }).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer();
  const a = await fig.raw().toBuffer();
  const diff = Buffer.alloc(fw * fh * 3);
  let bad = 0;
  for (let p = 0; p < fw * fh; p++) {
    const i = p * 3;
    const delta = Math.max(Math.abs(a[i] - crop[i]), Math.abs(a[i + 1] - crop[i + 1]), Math.abs(a[i + 2] - crop[i + 2]));
    if (delta > pixelThreshold) {
      bad++;
      diff[i] = 255;
    } else {
      diff[i] = diff[i + 1] = diff[i + 2] = Math.round((crop[i] + 255 * 2) / 3);
    }
  }
  const gap = 8;
  await sharp({ create: { width: fw * 3 + gap * 2, height: fh, channels: 3, background: "#ffffff" } })
    .composite([
      { input: a, raw: { width: fw, height: fh, channels: 3 }, left: 0, top: 0 },
      { input: crop, raw: { width: fw, height: fh, channels: 3 }, left: fw + gap, top: 0 },
      { input: diff, raw: { width: fw, height: fh, channels: 3 }, left: (fw + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(outPng);
  return { pct: (100 * bad) / (fw * fh), heightRatio: h / dom.h };
}
/* ---------- Figma: metadata and design context ---------- */

/** get_metadata's flat tag format. Positions are relative to the parent. */
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

/** One page frame per breakpoint: the top-level frames, or the frames directly under a section/canvas. */
function pageFrames(roots) {
  const found = {};
  const candidates = roots.flatMap((n) => (n.tag === "frame" ? [n] : n.children.filter((c) => c.tag === "frame")));
  for (const f of candidates) {
    const bp = bpOfWidth(f.w);
    if (!found[bp] || (bpHint(f.name) === bp && bpHint(found[bp].name) !== bp)) found[bp] = f;
  }
  return found;
}

/**
 * Every text node of a page frame with its box, relative to the page's left edge
 * and to the top of its own section (the frame's direct child).
 */
function figmaSections(frame) {
  return frame.children.map((section, index) => {
    const texts = [];
    const walk = (node, ox, oy) => {
      for (const c of node.children) {
        if (c.tag === "text") texts.push({ id: c.id, x: ox + c.x, y: oy + c.y, w: c.w, h: c.h });
        else walk(c, ox + c.x, oy + c.y);
      }
    };
    walk(section, 0, 0);
    return { index, id: section.id, name: section.name || section.tag, tag: section.tag, y: section.y, h: section.h, texts };
  });
}

/** The index just past the `>` that closes the opening tag that starts at `from`, honouring quotes and {braces}. */
function openingTagEnd(code, from) {
  let quote = null;
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === quote && code[i - 1] !== "\\") quote = null;
    } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "`" && depth > 0) {
      const end = code.indexOf("`", i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (c === ">" && depth === 0) return i + 1;
  }
  return -1;
}

/** The words of the text node with `data-node-id="id"` in a get_design_context capture, or null. */
function contextText(code, id) {
  const at = code.indexOf(`data-node-id="${id}"`);
  if (at === -1) return null;
  const open = code.lastIndexOf("<", at);
  const tag = code.slice(open + 1).match(/^[\w.-]+/)?.[0];
  if (!tag) return null;
  const start = openingTagEnd(code, open + 1 + tag.length);
  if (start === -1 || code[start - 2] === "/") return "";
  let depth = 1;
  const re = new RegExp(`<(/?)${tag.replace(/\./g, "\\.")}(?=[\\s>/])`, "g");
  re.lastIndex = start;
  let end = code.length;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  const inner = code
    .slice(start, end)
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\{`([\s\S]*?)`\}/g, "$1")
    .replace(/\{"([^"]*)"\}/g, "$1")
    .replace(/\{'([^']*)'\}/g, "$1");
  return decode(inner);
}

/** Text nodes inside instances: they have a context entry but no box in metadata. */
function instanceTextCount(code) {
  const ids = new Set();
  for (const m of code.matchAll(/<(?:p|span|h[1-6])\b[^<]*?data-node-id="(I[^"]+)"/g)) ids.add(m[1]);
  return ids.size;
}

function findFigmaFiles() {
  if (!existsSync(folder)) fail(`${folder}: folder not found`);
  const names = readdirSync(folder).filter((n) => n.startsWith(page) && !n.endsWith(".png")).sort();
  const xml = names.filter((n) => n.endsWith(".xml")).sort((a, b) => Number(b.includes("metadata")) - Number(a.includes("metadata")))[0];
  if (!xml) fail(`${folder}: no metadata XML starting with "${page}" (expected ${page}-metadata.xml)`);
  const context = {};
  for (const bp of ["desktop", "tablet", "mobile"]) {
    const name = names.find((n) => !n.endsWith(".xml") && n.toLowerCase().includes(bp) && readFileSync(join(folder, n), "utf8").includes("data-node-id="));
    if (name) context[bp] = join(folder, name);
  }
  return { xml: join(folder, xml), context };
}

/* ---------- Chrome over the DevTools protocol ---------- */

function chromePath() {
  const given = flag("chrome");
  if (given) return existsSync(given) ? given : fail(`--chrome ${given}: not found`);
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return fail("Chrome not found: install it or pass --chrome <path>");
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function launchChrome() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "verify-chrome-"));
  const proc = spawn(
    chromePath(),
    [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
      "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
      "--force-color-profile=srgb", "--font-render-hinting=none", "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  proc.once("exit", () => (exited = true));
  proc.once("error", (e) => fail(`could not start Chrome: ${e.message}`));
  const close = () => {
    if (!exited) proc.kill("SIGKILL");
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  for (let i = 0; i < 100; i++) {
    if (exited) {
      close();
      fail("Chrome exited before the DevTools port opened");
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { wsUrl: (await res.json()).webSocketDebuggerUrl, close };
    } catch {}
    await sleep(150);
  }
  close();
  return fail("Chrome did not open its DevTools port within 15s");
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("DevTools WebSocket failed to open"));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  /** Resolves on the next matching event; call it BEFORE the action that fires the event. */
  const once = (method, sessionId, ms = 60000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(l);
        reject(new Error(`timed out waiting for ${method}`));
      }, ms);
      const l = (m) => {
        if (m.method === method && m.sessionId === sessionId) {
          clearTimeout(timer);
          listeners.delete(l);
          resolve(m.params);
        }
      };
      listeners.add(l);
    });
  return { send, once, close: () => ws.close() };
}

/* ---------- what runs inside the page (serialised with toString) ---------- */

/** Returns the page sections and every visible text element, in document coordinates. */
function pageProbe(selector) {
  const norm = (s) => s.replace(/[\u00a0\s]+/g, " ").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim().toLowerCase();
  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT", "ASTRO-DEV-TOOLBAR"]);
  const cs = (el) => getComputedStyle(el);
  const sx = window.scrollX;
  const sy = window.scrollY;
  const label = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "");
  };

  const inFlow = (el) => {
    if (SKIP.has(el.tagName)) return false;
    const s = cs(el);
    return s.display !== "none" && s.position !== "fixed" && s.position !== "absolute";
  };
  const semantic = (el) => ["HEADER", "NAV", "MAIN", "FOOTER"].includes(el.tagName);
  const els = [];
  if (selector) els.push(...document.querySelectorAll(selector));
  else {
    const collect = (parent) => {
      const kids = [...parent.children].filter(inFlow);
      for (const el of kids) {
        const expand =
          cs(el).display === "contents" ||
          el.tagName === "MAIN" ||
          (el.tagName === "DIV" && [...el.children].some(semantic)) ||
          (el.tagName === "DIV" && kids.length === 1 && [...el.children].filter(inFlow).length >= 2);
        if (expand) collect(el);
        else if (el.getBoundingClientRect().height > 0) els.push(el);
      }
    };
    collect(document.body);
  }
  const sections = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { label: label(el), x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
  });

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && cs(el).visibility !== "hidden";
  };
  const textOf = new Map();
  const text = (el) => {
    if (!textOf.has(el)) textOf.set(el, norm(el.innerText ?? ""));
    return textOf.get(el);
  };
  const box = (el) => {
    const s = cs(el);
    const r = el.getBoundingClientRect();
    const iconBeside = Boolean(el.querySelector(":scope > svg, :scope > img"));
    if (s.display === "inline" || iconBeside) {
      const rg = document.createRange();
      let rs;
      if (iconBeside) {
        /* An icon inside the element is not part of the text Figma measured: use the text nodes alone. */
        rs = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim()) continue;
          rg.selectNodeContents(n);
          rs.push(...[...rg.getClientRects()].filter((q) => q.width > 0));
        }
      } else {
        rg.selectNodeContents(el);
        rs = [...rg.getClientRects()].filter((q) => q.width > 0);
      }
      if (!rs.length) return null;
      const left = Math.min(...rs.map((q) => q.left));
      const right = Math.max(...rs.map((q) => q.right));
      const top = Math.min(...rs.map((q) => q.top));
      const bottom = Math.max(...rs.map((q) => q.bottom));
      const lh = parseFloat(s.lineHeight);
      if (!Number.isFinite(lh)) return { x: left + sx, y: top + sy, w: right - left, h: bottom - top };
      const lines = new Set(rs.map((q) => Math.round(q.top))).size;
      return { x: left + sx, y: top - (lh - rs[0].height) / 2 + sy, w: right - left, h: lines * lh };
    }
    const px = (name) => parseFloat(s[name]) || 0;
    const l = px("borderLeftWidth") + px("paddingLeft");
    const rt = px("borderRightWidth") + px("paddingRight");
    const t = px("borderTopWidth") + px("paddingTop");
    const b = px("borderBottomWidth") + px("paddingBottom");
    return { x: r.left + l + sx, y: r.top + t + sy, w: r.width - l - rt, h: r.height - t - b };
  };

  const texts = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("script,style,svg,noscript,template,astro-dev-toolbar") || !visible(el)) continue;
    const t = text(el);
    if (!t) continue;
    if ([...el.children].some((c) => visible(c) && text(c) === t)) continue; // a child holds the same words
    const b = box(el);
    if (!b) continue;
    texts.push({ text: t, ...b, sec: els.findIndex((s) => s.contains(el)), label: label(el) });
  }
  return { sections, texts, docHeight: document.documentElement.scrollHeight };
}

/** Scrolls the page once top to bottom so lazy media gets a size, waits for images, then goes back to the top. */
async function settlePage() {
  const step = Math.max(200, innerHeight - 100);
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  scrollTo(0, 0);
  const images = [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }));
  await Promise.race([Promise.all(images), new Promise((r) => setTimeout(r, 10000))]);
  await document.fonts.ready;
  await new Promise((r) => setTimeout(r, 300));
  return true;
}

/* ---------- compare ---------- */

/**
 * Which DOM section answers each Figma section: pairs[figmaIndex] = domIndex, or -1.
 * Order alone breaks the moment a section is missing or extra (every row after it is
 * compared with the wrong section), so words decide. The alignment keeps the page order
 * and maximises how many Figma texts the paired DOM section also contains. The navbar
 * and footer pair with the header and footer elements; a section with no text of its
 * own (a hero with no children in the metadata) takes the one DOM section left in the gap.
 */
function pairSections(fSections, dSections, dTexts, capture) {
  const n = fSections.length;
  const m = dSections.length;
  const domWords = dSections.map((_, di) => new Set(dTexts.filter((t) => t.sec === di).map((t) => t.text)));
  const score = (f, di) => {
    const label = dSections[di].label;
    if (/nav/i.test(f.name)) return /^(header|nav)/.test(label) ? 1000 : 0;
    if (/footer/i.test(f.name)) return /^footer/.test(label) ? 1000 : 0;
    if (/^(header|nav|footer)/.test(label)) return 0;
    const words = new Set(f.texts.map((t) => contextText(capture, t.id)).filter((raw) => raw !== null).map(normText).filter(Boolean));
    let hit = 0;
    for (const w of words) if (domWords[di].has(w)) hit++;
    return hit;
  };
  const s = fSections.map((f) => dSections.map((_, di) => score(f, di)));
  const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      best[i][j] = Math.max(best[i - 1][j], best[i][j - 1], s[i - 1][j - 1] > 0 ? best[i - 1][j - 1] + s[i - 1][j - 1] : 0);
    }
  }
  const pairs = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (s[i - 1][j - 1] > 0 && best[i][j] === best[i - 1][j - 1] + s[i - 1][j - 1]) {
      pairs[i - 1] = j - 1;
      i--;
      j--;
    } else if (best[i][j] === best[i - 1][j]) i--;
    else j--;
  }
  const taken = new Set(pairs.filter((p) => p >= 0));
  let prevF = -1;
  let prevD = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && pairs[i] < 0) continue;
    const nextD = i < n ? pairs[i] : m;
    const fGap = [];
    for (let k = prevF + 1; k < i; k++) if (!fSections[k].texts.length) fGap.push(k);
    const dGap = [];
    for (let k = prevD + 1; k < nextD; k++) if (!taken.has(k)) dGap.push(k);
    if (fGap.length === dGap.length) fGap.forEach((fi, k) => (pairs[fi] = dGap[k]));
    prevF = i;
    prevD = nextD;
  }
  return pairs;
}

function reportSections(fSections, dSections, pairs) {
  const unpaired = pairs.filter((p) => p < 0).length;
  const extra = dSections.length - pairs.filter((p) => p >= 0).length;
  if (unpaired || extra) {
    console.log(`WARNING: ${unpaired} of ${fSections.length} Figma section(s) have no DOM section${extra ? `, and ${extra} DOM section(s) match no Figma section` : ""}. Sections are paired by the words they share, so a missing section does not shift the rows below it.`);
  }
  let drift = 0;
  const rows = [];
  fSections.forEach((f, i) => {
    const d = dSections[pairs[i]];
    if (!d) {
      rows.push([i + 1, cut(f.name, 24), round1(f.y), round1(f.h), "—", "—", "—", "—", "—", "—"]);
      return;
    }
    const dh = d.h - f.h;
    drift += dh;
    rows.push([i + 1, cut(f.name, 24), round1(f.y), round1(f.h), cut(d.label, 28), round1(d.y), round1(d.h), signed(d.y - f.y), signed(dh), signed(drift)]);
  });
  const used = new Set(pairs);
  dSections.forEach((d, di) => {
    if (!used.has(di)) rows.push(["", "—", "—", "—", cut(d.label, 28), round1(d.y), round1(d.h), "—", "—", "—"]);
  });
  console.log("SECTIONS  (Δy = DOM y − Figma y; Δh = height delta; DRIFT = sum of Δh over the paired sections so far)");
  printTable(["#", "FIGMA", "Y", "H", "DOM", "Y", "H", "Δy", "Δh", "DRIFT"], rows);
}

function reportText(fSections, dSections, dTexts, capture, instanceTexts, pairs) {
  const stats = { matched: 0, paired: 0, ambiguous: 0, missing: 0, noWords: 0 };
  const compared = [];
  const ambiguous = [];
  const missing = [];
  for (const f of fSections) {
    const d = dSections[pairs[f.index]];
    if (!d) {
      for (const t of f.texts) if (contextText(capture, t.id) !== null) stats.missing++;
      continue;
    }
    const fByText = new Map();
    for (const t of f.texts) {
      const raw = contextText(capture, t.id);
      const words = raw === null ? "" : normText(raw);
      if (!words) {
        stats.noWords++;
        continue;
      }
      if (!fByText.has(words)) fByText.set(words, []);
      fByText.get(words).push({ ...t, words, raw });
    }
    const here = dTexts.filter((t) => t.sec === pairs[f.index]);
    for (const [words, group] of fByText) {
      const dom = here.filter((t) => t.text === words);
      if (!dom.length) {
        stats.missing += group.length;
        missing.push(...group.map((g) => ({ ...g, section: f })));
        continue;
      }
      if (dom.length !== group.length) {
        stats.ambiguous += group.length;
        ambiguous.push({ section: f, words, figma: group.length, dom: dom.length });
        continue;
      }
      const byReading = (a, b) => a.y - b.y || a.x - b.x;
      group.sort(byReading);
      dom.sort(byReading);
      group.forEach((g, i) => {
        stats.matched++;
        if (group.length > 1) stats.paired++;
        const e = dom[i];
        compared.push({
          section: f, id: g.id, words: g.words,
          dx: e.x - g.x, dy: e.y - d.y - g.y, dw: e.w - g.w, dh: e.h - g.h, el: e.label,
        });
      });
    }
  }

  const off = compared.filter((c) => Math.max(Math.abs(c.dx), Math.abs(c.dy), Math.abs(c.dw), Math.abs(c.dh)) > tolerance);
  const worst = (c) => Math.max(Math.abs(c.dx), Math.abs(c.dy), Math.abs(c.dw), Math.abs(c.dh));
  console.log(`\nTEXT  (Δ = DOM − Figma in px; x from the page's left edge, y from the section's top; tolerance ${tolerance}px)`);
  if (!off.length) console.log(compared.length ? "  every matched text is within tolerance" : "  nothing was matched");
  for (const f of fSections) {
    const rows = off.filter((c) => c.section === f).sort((a, b) => worst(b) - worst(a));
    if (!rows.length) continue;
    console.log(`\n  ${f.index + 1}. ${f.name}  — ${rows.length} of ${compared.filter((c) => c.section === f).length} matched texts over tolerance`);
    printTable(
      ["NODE", "TEXT", "ELEMENT", "Δx", "Δy", "Δw", "Δh"],
      rows.map((c) => [c.id, cut(c.words, 40), cut(c.el, 24), signed(c.dx), signed(c.dy), signed(c.dw), signed(c.dh)]),
      "    ",
    );
  }
  console.log(
    `\n  matched ${stats.matched} (${stats.paired} paired by reading order), ${off.length} over tolerance; ambiguous ${stats.ambiguous}; missing in DOM ${stats.missing}; no words in capture ${stats.noWords}; inside instances (no box in metadata) ${instanceTexts}`,
  );
  if (ambiguous.length) {
    console.log("  ambiguous (same words, different count in the section):");
    for (const a of ambiguous.slice(0, 15)) console.log(`    section ${a.section.index + 1}: "${cut(a.words, 50)}" Figma ×${a.figma}, DOM ×${a.dom}`);
    if (ambiguous.length > 15) console.log(`    … ${ambiguous.length - 15} more`);
  }
  if (missing.length) {
    console.log("  missing in the DOM section:");
    for (const m of missing.slice(0, 15)) console.log(`    section ${m.section.index + 1}: ${m.id} "${cut(m.words, 50)}"`);
    if (missing.length > 15) console.log(`    … ${missing.length - 15} more`);
  }
}

async function diffShots(sharp, figmaPng, webPng, diffPng, fSections, frameWidth, bp) {
  const figma = await sharp(figmaPng).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const fw = figma.info.width;
  const web = await sharp(webPng).resize({ width: fw }).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const height = Math.max(figma.info.height, web.info.height);
  const pad = (img) => {
    const out = Buffer.alloc(fw * height * 3, 255);
    img.data.copy(out);
    return out;
  };
  const a = pad(figma);
  const b = pad(web);
  const out = Buffer.alloc(fw * height * 3);
  const bad = new Uint8Array(fw * height);
  for (let p = 0; p < fw * height; p++) {
    const i = p * 3;
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (delta > pixelThreshold) {
      bad[p] = 1;
      out[i] = 255;
    } else {
      // the web shot, washed out, so the red stands on something readable
      out[i] = (b[i] + 255 * 2) / 3;
      out[i + 1] = (b[i + 1] + 255 * 2) / 3;
      out[i + 2] = (b[i + 2] + 255 * 2) / 3;
    }
  }
  await sharp(out, { raw: { width: fw, height, channels: 3 } }).png().toFile(diffPng);

  const scale = fw / frameWidth;
  const band = (from, to) => {
    const y0 = Math.max(0, Math.round(from * scale));
    const y1 = Math.min(height, Math.round(to * scale));
    let n = 0;
    for (let p = y0 * fw; p < y1 * fw; p++) n += bad[p];
    return y1 > y0 ? (100 * n) / ((y1 - y0) * fw) : 0;
  };
  console.log(`\nDIFF  (${bp}: web shot scaled to the Figma export's ${fw}px width; mismatch = a channel differs by more than ${pixelThreshold}/255)`);
  console.log(`  Figma export ${fw}×${figma.info.height}, web ${fw}×${web.info.height}${figma.info.height === web.info.height ? "" : ` — heights differ by ${web.info.height - figma.info.height}px, so everything below the first drift is shifted`}`);
  printTable(
    ["#", "FIGMA", "BAND Y", "BAND H", "MISMATCH"],
    [
      ...fSections.map((s) => [s.index + 1, cut(s.name, 24), round1(s.y), round1(s.h), `${band(s.y, s.y + s.h).toFixed(1)}%`]),
      ["", "whole page", 0, height / scale, `${band(0, height / scale).toFixed(1)}%`],
    ],
    "  ",
  );
  console.log(`  wrote ${diffPng}`);
}

/* ---------- main ---------- */

async function main() {
  const { xml, context } = findFigmaFiles();
  const frames = pageFrames(parseMetadata(readFileSync(xml, "utf8"), xml));
  const breakpoints = ["desktop", "tablet", "mobile"].filter((bp) => frames[bp]);
  if (!breakpoints.length) fail(`${xml}: no page frames found`);

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    fail(`${url}: not reachable (${e.cause?.code ?? e.message})`);
  }
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);

  let sharp = null;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.log("note: sharp is not installed, screenshot diffs are skipped");
  }

  const figma = useFigma && sharp ? await figmaClient() : null;
  if (useFigma && sharp && !figma) console.log(`note: Figma desktop is not answering on ${FIGMA_MCP}; section screenshots from Figma are skipped (open the file in Figma desktop with Dev Mode MCP enabled)`);
  const chrome = await launchChrome();
  process.once("SIGINT", () => {
    chrome.close();
    process.exit(130);
  });
  try {
    const cdp = await connect(chrome.wsUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = (method, params) => cdp.send(method, params, sessionId);
    await tab("Page.enable");
    await tab("Runtime.enable");
    await tab("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const evaluate = async (expression) => {
      const r = await tab("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    console.log(`verify  ${url}  page "${page}"  metadata ${xml}  tolerance ${tolerance}px`);
    for (const bp of breakpoints) {
      const frame = frames[bp];
      const width = Math.round(frame.w);
      console.log(`\n${"=".repeat(78)}\n${bp.toUpperCase()} ${width}px  (Figma frame "${frame.name}", ${round1(frame.h)}px tall)\n${"=".repeat(78)}`);

      await tab("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const loaded = cdp.once("Page.loadEventFired", sessionId);
      const nav = await tab("Page.navigate", { url });
      if (nav.errorText) fail(`${url}: ${nav.errorText}`);
      await loaded;
      await evaluate(`(() => { const s = document.createElement("style"); s.textContent = "astro-dev-toolbar{display:none!important}"; document.head.append(s); })()`);
      await evaluate(`(${settlePage.toString()})()`);

      const probe = await evaluate(`(${pageProbe.toString()})(${JSON.stringify(sectionSelector ?? null)})`);
      const fSections = figmaSections(frame);
      if (!probe.sections.length) console.log("WARNING: no DOM sections found; is the page empty?");
      const pairs = pairSections(fSections, probe.sections, probe.texts, readFileSync(context[bp] ?? xml, "utf8"));
      reportSections(fSections, probe.sections, pairs);

      const captureFile = context[bp];
      if (captureFile) {
        const capture = readFileSync(captureFile, "utf8");
        reportText(fSections, probe.sections, probe.texts, capture, instanceTextCount(capture), pairs);
      } else console.log(`\nTEXT  skipped: no ${page}-${bp} design-context capture in ${folder}/`);

      const shots = join(folder, "shots");
      mkdirSync(shots, { recursive: true });
      const webPng = join(shots, `${page}-${bp}-web.png`);
      const height = Math.ceil(probe.docHeight);
      const shot = await tab("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      writeFileSync(webPng, Buffer.from(shot.data, "base64"));
      console.log(`\nSHOT  wrote ${webPng} (${width}×${height})`);

      const figmaPng = join(shots, `${page}-${bp}.png`);
      if (existsSync(figmaPng)) {
        if (sharp) await diffShots(sharp, figmaPng, webPng, join(shots, `${page}-${bp}-diff.png`), fSections, width, bp);
      } else if (!figma) console.log(`  no Figma export at ${figmaPng}; to diff, export the frame there (Figma: select frame → Export → PNG, 1x)`);

      if (figma) {
        const rows = [];
        for (const f of fSections) {
          const d = probe.sections[pairs[f.index]];
          if (!d) {
            rows.push([f.index + 1, cut(f.name, 24), "—", "no DOM section", ""]);
            continue;
          }
          const shot = await figma.screenshot(f.id);
          if (!shot.png) {
            rows.push([f.index + 1, cut(f.name, 24), "—", cut(shot.error, 40), ""]);
            continue;
          }
          const out = join(shots, `${page}-${bp}-${String(f.index + 1).padStart(2, "0")}-${f.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
          const r = await sectionDiff(sharp, shot.png, webPng, d, out);
          rows.push([f.index + 1, cut(f.name, 24), `${r.pct.toFixed(1)}%`, out, ""]);
        }
        console.log(`\nSECTION DIFF  (Figma screenshot of each section | web crop at the DOM section's own position | red where a channel differs by more than ${pixelThreshold}/255)`);
        printTable(["#", "FIGMA", "MISMATCH", "IMAGE"], rows.map((r) => r.slice(0, 4)), "  ");
        if (rows.length && rows.every((r) => /no node could be found/i.test(String(r[3])))) {
          console.log("  Figma desktop answered but has another file in front: bring the design's tab to the front in Figma desktop and run again.");
        }
      }
    }
    cdp.close();
  } finally {
    chrome.close();
  }
}

main().catch((e) => fail(`verify failed: ${e.message}`));
