#!/usr/bin/env node
/**
 * Reads a page through the Figma plugin bridge (figma-bridge.mjs) instead of the
 * official Figma MCP, so a slice spends no Figma API or Dev Mode quota. Writes
 *
 *   <folder>/<page>-node.json                   the get_node dump of the node, as returned
 *   <folder>/<page>-metadata.xml                the dump as get_metadata XML, for convert and verify
 *   <folder>/<Collection>.json                  each variable collection, as the Export/Import
 *                                               Variables plugin writes it (Responsive.json, Static.json)
 *   <folder>/figma-styles.json                  the file's paint, text and effect styles (get_styles),
 *                                               so shadows take their effect style's name
 *   <folder>/shots/figma-cache/<node-id>.png    a 1x screenshot of every section of every frame
 *
 * Give it the node that holds the page's three breakpoint frames (a SECTION), or
 * one frame. The data goes from the bridge to disk directly; a multi-MB dump never
 * passes through the agent.
 *
 * Anything already saved is kept (`--force` fetches again), so a run that stopped
 * picks up where it left off. A metadata XML saved off the official MCP, or a
 * variable file exported with the plugin, is never overwritten. Photos still come from the official MCP (`download_assets`): the
 * bridge holds an image's hash, not the file, so the IMAGE fills are listed.
 *
 * `--svg <dir> <nodeId>=<name> …` instead exports icons as SVG into <dir> (for
 * example src/assets/service), one file per job, the list `convert.mjs --folder`
 * prints under ICONS. A file already there is kept unless --force.
 *
 * Usage:
 *   node bridge.mjs --page service --node 6825:45642 [--folder figma] [--force] [--no-shots] [--file-key <key>]
 *   node bridge.mjs --svg src/assets/service 6825:40191=arrow-right 6825:40200=check [--force] [--file-key <key>]
 *
 * Exits 2 when the bridge cannot read the node (no bridge answers, no Figma file
 * has the plugin open, or the open file does not hold the node), so the caller
 * falls back to the official MCP; 1 on any other failure.
 * Plain Node, no dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_URL, bridgeClient, dumpToMetadataXml, dumpTree, isNodeDump, variableExports } from "./figma-bridge.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const page = flag("page");
const nodeArg = flag("node");
const folder = flag("folder", "figma");
const fileKey = flag("file-key");
const force = args.includes("--force");
const svgDir = flag("svg");
if (svgDir) {
  const jobs = args.filter((a, i) => !a.startsWith("--") && !["--svg", "--file-key"].includes(args[i - 1]));
  if (!jobs.length) fail("usage: node bridge.mjs --svg src/assets/<page> <nodeId>=<name> ...");
  for (const j of jobs) if (!/^I?\d+[:-]\d+(;\d+[:-]\d+)*=[\w-]+$/.test(j)) fail(`${j}: expected <nodeId>=<name>, for example 6825:40191=arrow-right`);
  const bridge = await bridgeClient(fileKey);
  if (!bridge) fail(`figma-bridge is not answering on ${BRIDGE_URL}, or no Figma file has the plugin open: export the icons with the official Figma MCP`, 2);
  mkdirSync(svgDir, { recursive: true });
  const failed = [];
  for (const job of jobs) {
    const [raw, name] = job.split("=");
    const file = join(svgDir, `${name}.svg`);
    if (!force && existsSync(file)) {
      console.log(`${name}  kept (${file} exists; --force exports again)`);
      continue;
    }
    const got = await bridge.svg(raw.replace(/(\d)-(\d)/g, "$1:$2"));
    if (got.error) {
      failed.push(`${job}: ${got.error}`);
      continue;
    }
    writeFileSync(file, got.svg);
    console.log(`${name}  ${file}  ${got.svg.length} bytes`);
  }
  if (failed.length) fail(`${failed.length} icon(s) failed:\n  ${failed.join("\n  ")}`);
  console.log("Run convert.mjs --clean-svg on them, then use fill=\"currentColor\" where an icon follows the text colour.");
  process.exit(0);
}
if (!page || !nodeArg) fail("usage: node bridge.mjs --page service --node 6825:45642 [--folder figma] [--force] [--no-shots] [--file-key <key>]");
const nodeId = nodeArg.replace(/(\d)-(\d)/g, "$1:$2");
if (!/^I?\d+:\d+(;\d+:\d+)*$/.test(nodeId)) fail(`--node ${nodeArg}: expected a node id such as 6825:45642`);

/** The cache file verify.mjs looks for: the node id with `:` and `;` as `-`. */
const cacheFile = (id) => join(folder, "shots", "figma-cache", `${id.replace(/[^\w-]/g, "-")}.png`);
const bpOfWidth = (w) => (w >= 992 ? "desktop" : w >= 768 ? "tablet" : "mobile");

const bridge = await bridgeClient(fileKey);
if (!bridge) fail(`figma-bridge is not answering on ${BRIDGE_URL}, or no Figma file has the plugin open: run the plugin in Figma desktop, or use the official Figma MCP (capture.mjs)`, 2);
if (bridge.files.length > 1 && !fileKey) {
  fail(`Several Figma files have the plugin open; pass --file-key:\n${bridge.files.map((f) => `  ${f.fileKey}  ${f.fileName}`).join("\n")}`);
}
console.log(`figma-bridge  ${bridge.files.find((f) => !fileKey || f.fileKey === fileKey)?.fileName ?? fileKey}`);

mkdirSync(folder, { recursive: true });
const dumpFile = join(folder, `${page}-node.json`);
let dump;
if (!force && existsSync(dumpFile)) {
  dump = JSON.parse(readFileSync(dumpFile, "utf8"));
  console.log(`node     ${dumpFile} already saved (--force fetches again)`);
} else {
  /* A node the open file does not hold comes back after a timeout as a "connection" error: either way the bridge cannot read it, so the caller falls back. */
  const open = bridge.files.find((f) => !fileKey || f.fileKey === fileKey)?.fileName;
  dump = await bridge.node(nodeId).catch((e) => fail(`get_node ${nodeId}: ${e.message}\nThe node is probably not in the file the plugin has open ("${open}"): open the file that holds it and run the plugin there, or use the official Figma MCP (capture.mjs)`, 2));
  if (!isNodeDump(dump)) fail(`get_node ${nodeId}: not a node with children`);
  const text = JSON.stringify(dump);
  writeFileSync(dumpFile, text);
  console.log(`node     ${dumpFile}  ${(text.length / 1e6).toFixed(1)} MB`);
}

const xmlFile = join(folder, `${page}-metadata.xml`);
if (!force && existsSync(xmlFile) && !readFileSync(xmlFile, "utf8").includes('source="figma-bridge"')) {
  console.log(`metadata ${xmlFile} is from the official MCP: kept (delete it to write one from the dump)`);
} else {
  writeFileSync(xmlFile, dumpToMetadataXml(dump));
  console.log(`metadata ${xmlFile}`);
}

/* The variables belong to the file, not the page: one set serves every page. */
const defs = await bridge.variables().catch((e) => {
  console.log(`variables  not read: ${e.message}`);
  return null;
});
for (const { name, data } of defs ? variableExports(defs) : []) {
  const file = join(folder, `${name.replace(/[^\w -]/g, "").trim() || "variables"}.json`);
  if (existsSync(file) && !JSON.parse(readFileSync(file, "utf8")).source) {
    console.log(`variables ${file} was exported with the plugin: kept (delete it to write one from the bridge)`);
    continue;
  }
  if (existsSync(file) && !force) {
    console.log(`variables ${file} already saved (--force fetches again)`);
    continue;
  }
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`variables ${file}  ${data.variables.length} variables, modes ${Object.values(data.modes).join("/")}`);
}

const stylesFile = join(folder, "figma-styles.json");
if (force || !existsSync(stylesFile)) {
  const styles = await bridge.styles().catch(() => null);
  if (styles) {
    writeFileSync(stylesFile, JSON.stringify({ source: "figma-bridge", ...styles }, null, 2));
    console.log(`styles   ${stylesFile}  ${styles.effects?.length ?? 0} effect, ${styles.text?.length ?? 0} text, ${styles.paints?.length ?? 0} paint style(s)`);
  }
}

const root = dumpTree(dump);
const frames = root.tag === "frame" ? [root] : root.children.filter((c) => c.tag === "frame" && !c.hidden);
if (!frames.length) fail(`${nodeId} ("${root.name}") holds no frame: give the section that holds the breakpoint frames, or a frame`);
for (const f of frames) console.log(`frame    ${bpOfWidth(f.w).padEnd(7)} ${f.w}px  ${f.children.filter((c) => !c.hidden).length} sections  "${f.name}"`);

if (!args.includes("--no-shots")) {
  mkdirSync(join(folder, "shots", "figma-cache"), { recursive: true });
  let saved = 0;
  let kept = 0;
  const failed = [];
  for (const f of frames) {
    for (const s of f.children.filter((c) => !c.hidden)) {
      const file = cacheFile(s.id);
      if (!force && existsSync(file)) {
        kept++;
        continue;
      }
      const shot = await bridge.screenshot(s.id);
      if (!shot.png) {
        failed.push(`${s.id} "${s.name}": ${shot.error}`);
        continue;
      }
      writeFileSync(file, shot.png);
      saved++;
    }
  }
  console.log(`shots    ${saved} saved, ${kept} already in ${join(folder, "shots", "figma-cache")}/${failed.length ? `, ${failed.length} failed` : ""}`);
  for (const l of failed) console.log(`  ! ${l}`);
}

/* The bridge has an image's hash, not its file: photos come from the official MCP. One node per image. */
const photos = new Map();
const walk = (n) => {
  for (const fill of n.styles?.fills ?? []) {
    if (fill.type === "IMAGE" && fill.imageHash && !photos.has(fill.imageHash)) photos.set(fill.imageHash, `${n.id} "${n.name}" ${fill.scaleMode ?? ""}`.trim());
  }
  for (const c of n.children ?? []) walk(c);
};
walk(dump);
if (photos.size) {
  console.log(`\nPHOTOS  ${photos.size} distinct image fill(s); download each with the official MCP (download_assets <nodeId>):`);
  for (const p of photos.values()) console.log(`  ${p}`);
}
