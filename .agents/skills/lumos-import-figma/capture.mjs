#!/usr/bin/env node
/**
 * Saves get_design_context captures from Figma desktop's Dev Mode MCP server
 * (127.0.0.1:3845), one call per node, and keeps the screenshot that call
 * already returns, so verify.mjs does not ask Figma for it a second time.
 *
 * Each job `<name>=<nodeId>` writes
 *   <folder>/<page>-<name>.txt                  the capture, as convert.mjs and verify.mjs read it
 *   <folder>/shots/figma-cache/<node-id>.png    the node's screenshot, verify.mjs's cache
 *
 * A job whose .txt and .png both exist is skipped, so a capture is never made
 * twice; `--force` fetches it again. An MCP error is never saved as a capture.
 * A rate limit stops the run and lists the jobs left, so the next run (or the
 * remote MCP) picks up where this one stopped.
 *
 * Usage:
 *   node capture.mjs --page about [--folder figma] [--force] desktop-01-hero=6819:36460 desktop-02-logos=6819:36512 ...
 *
 * Exits non-zero when a job failed or was left. Plain Node, no dependencies.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIGMA_MCP = "http://127.0.0.1:3845/mcp";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const page = flag("page");
const folder = flag("folder", "figma");
const force = args.includes("--force");
const jobs = args.filter((a, i) => !a.startsWith("--") && !["--page", "--folder"].includes(args[i - 1]));
if (!page || !jobs.length) fail("usage: node capture.mjs --page about [--folder figma] [--force] <name>=<nodeId> ...");
for (const j of jobs) if (!/^[\w-]+=I?\d+[:-]\d+(;\d+[:-]\d+)*$/.test(j)) fail(`${j}: expected <name>=<nodeId>, for example desktop-01-hero=6819:36460`);

/** The cache file verify.mjs looks for: the node id with `:` and `;` as `-`. */
const cacheFile = (id) => join(folder, "shots", "figma-cache", `${id.replace(/[^\w-]/g, "-")}.png`);

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
    res = await fetch(FIGMA_MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lumos-capture", version: "1" } } }) });
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
    /** The capture's text and screenshot, or the reason there is none. */
    async designContext(nodeId) {
      const r = await fetch(FIGMA_MCP, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "get_design_context", arguments: { nodeId, forceCode: true, clientFrameworks: "astro", clientLanguages: "html,css,typescript" } } }) });
      const msg = await read(r);
      const content = msg?.result?.content ?? [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n\n");
      const img = content.find((c) => c.type === "image");
      /* convert.mjs's own test for a saved error: no node ids and short. */
      if (msg?.result?.isError || !text.includes("data-node-id=")) return { error: text || msg?.error?.message || "empty response" };
      return { text, png: img ? Buffer.from(img.data, "base64") : null };
    },
  };
}

const figma = await figmaClient();
if (!figma) fail(`Figma desktop is not answering on ${FIGMA_MCP}: open the file in Figma desktop with Dev Mode MCP enabled, or capture through the remote Figma MCP`);

mkdirSync(join(folder, "shots", "figma-cache"), { recursive: true });
let skipped = 0;
const failed = [];
for (const [n, job] of jobs.entries()) {
  const [name, raw] = job.split("=");
  const nodeId = raw.replace(/(\d)-(\d)/g, "$1:$2");
  const txt = join(folder, `${page}-${name}.txt`);
  const png = cacheFile(nodeId);
  if (!force && existsSync(txt) && existsSync(png)) {
    skipped++;
    continue;
  }
  const got = await figma.designContext(nodeId).catch((e) => ({ error: e.message }));
  if (got.error) {
    console.log(`${name}  ${nodeId}  ERROR ${got.error.split("\n")[0]}`);
    if (/rate limit|exceeded/i.test(got.error)) {
      const left = jobs.slice(n);
      console.log(`\nRate limited: stopped. ${left.length} job(s) not captured:\n  ${left.join(" ")}`);
      process.exit(1);
    }
    failed.push(job);
    continue;
  }
  writeFileSync(txt, got.text);
  if (got.png) writeFileSync(png, got.png);
  console.log(`${name}  ${nodeId}  ${got.text.length} chars${got.png ? `, screenshot → ${png}` : ", no screenshot in the response"}`);
}
if (skipped) console.log(`${skipped} job(s) skipped: capture and screenshot already saved (--force fetches again)`);
if (failed.length) fail(`${failed.length} job(s) failed: ${failed.join(" ")}`);
