/**
 * The Figma plugin bridge (github.com/gethopp/figma-mcp-bridge): a plugin in
 * Figma desktop streams the open file to a local server, so reading it spends
 * no Figma API or Dev Mode quota. Shared by bridge.mjs, convert.mjs and verify.mjs.
 *
 * Two parts:
 *
 *   RPC          The bridge's leader answers `POST /rpc` on 127.0.0.1:1994
 *                (FIGMA_BRIDGE_PORT) with `{ tool, nodeIds, params, fileKey }`,
 *                the same tools its MCP server lists. Only read tools are used here.
 *
 *   Node dump    `get_node` on a node returns `{ id, name, type, bounds, styles,
 *                children, characters }`. Bounds are relative to the parent, except
 *                inside a GROUP or BOOLEAN_OPERATION, whose children keep the group's
 *                parent space (Figma's own rule); they are made relative to the
 *                group here, so every consumer reads positions as get_metadata's.
 *                Hidden layers are left out of the dump altogether. It does not hold
 *                which variable or style a value is bound to, nor a text's textCase.
 *
 * Plain Node, no dependencies.
 */

const PORT = Number(process.env.FIGMA_BRIDGE_PORT ?? 1994);
export const BRIDGE_URL = `http://127.0.0.1:${PORT}`;

/** A bridge client, or null when no bridge is running or no Figma file has the plugin open. */
export async function bridgeClient(fileKey) {
  try {
    const ping = await fetch(`${BRIDGE_URL}/ping`, { signal: AbortSignal.timeout(2000) });
    if (!ping.ok) return null;
  } catch {
    return null;
  }
  const rpc = async (tool, nodeIds, params) => {
    const res = await fetch(`${BRIDGE_URL}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, ...(nodeIds ? { nodeIds } : {}), ...(params ? { params } : {}), ...(fileKey ? { fileKey } : {}) }),
    });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (body.error) throw new Error(body.error);
    return body.data;
  };
  const files = await rpc("list_files").catch(() => []);
  if (!files.length) return null;
  return {
    files,
    /** The whole subtree of a node, as get_node returns it. */
    node: (nodeId) => rpc("get_node", [nodeId]),
    /** Every local variable collection, as get_variable_defs returns it. */
    variables: () => rpc("get_variable_defs"),
    /** The file's local paint, text, effect and grid styles, as get_styles returns them. */
    styles: () => rpc("get_styles"),
    /** A node exported as SVG markup, or the reason there is none. */
    async svg(nodeId) {
      try {
        const data = await rpc("get_screenshot", [nodeId], { format: "SVG" });
        const shot = data?.exports?.[0];
        return shot?.base64 ? { svg: Buffer.from(shot.base64, "base64").toString("utf8") } : { error: "no SVG in the bridge response" };
      } catch (e) {
        return { error: e.message };
      }
    },
    /** PNG bytes of a node at 1x, or the reason there are none. */
    async screenshot(nodeId) {
      try {
        const data = await rpc("get_screenshot", [nodeId], { format: "PNG", scale: 1 });
        const shot = data?.exports?.[0];
        return shot?.base64 ? { png: Buffer.from(shot.base64, "base64") } : { error: "no image in the bridge response" };
      } catch (e) {
        return { error: e.message };
      }
    },
  };
}

/**
 * get_variable_defs as the files the Export/Import Variables plugin writes, one per collection, so
 * convert.mjs reads them like an export: `modes` as an id → name map, `type`, and
 * `resolvedValuesByMode` with every alias followed to its value (in the target collection's own
 * mode when it has the same one, else its first). `source: "figma-bridge"` marks them.
 */
export function variableExports(defs) {
  const byId = new Map(defs.collections.flatMap((c) => c.variables.map((v) => [v.id, { v, c }])));
  const plain = (value) => (value && value.type === "COLOR" ? { r: value.r, g: value.g, b: value.b, a: value.a } : value);
  const resolve = (value, modeId, depth = 0) => {
    if (!value || value.type !== "VARIABLE_ALIAS") return plain(value);
    const hit = byId.get(value.id);
    if (!hit || depth > 10) return null;
    const mode = modeId in hit.v.valuesByMode ? modeId : hit.c.modes[0]?.modeId;
    return resolve(hit.v.valuesByMode[mode], mode, depth + 1);
  };
  return defs.collections.map((c) => ({
    name: c.name,
    data: {
      id: c.id, name: c.name, source: "figma-bridge",
      modes: Object.fromEntries(c.modes.map((m) => [m.modeId, m.name])),
      variableIds: c.variables.map((v) => v.id),
      variables: c.variables.map((v) => ({
        id: v.id, name: v.name, type: v.resolvedType,
        valuesByMode: Object.fromEntries(Object.entries(v.valuesByMode).map(([m, value]) => [m, plain(value)])),
        resolvedValuesByMode: Object.fromEntries(Object.entries(v.valuesByMode).map(([m, value]) => [
          m, { resolvedValue: resolve(value, m), alias: value?.type === "VARIABLE_ALIAS" ? value.id : null },
        ])),
      })),
    },
  }));
}

/** The first solid paint of a fill or stroke list as `{ hex, alpha }`; null for none, "mixed" or a gradient only. */
export function solidPaint(paints) {
  if (!Array.isArray(paints)) return null;
  const p = paints.find((x) => x.type === "SOLID");
  return p ? { hex: p.color.toLowerCase(), alpha: p.opacity ?? 1 } : null;
}

/** Whether parsed JSON is a get_node dump: an id, a type, bounds and children at the root. */
export const isNodeDump = (data) =>
  Boolean(data && !Array.isArray(data) && typeof data.id === "string" && typeof data.type === "string" && data.bounds && Array.isArray(data.children));

const GROUPS = new Set(["GROUP", "BOOLEAN_OPERATION"]);

/** get_metadata's tag for a node type: lower case with hyphens, a rectangle with corners is a rounded-rectangle. */
function tagOf(n) {
  if (n.type === "RECTANGLE") return n.styles?.cornerRadius || n.styles?.cornerRadii ? "rounded-rectangle" : "rectangle";
  return n.type.toLowerCase().replace(/_/g, "-");
}

/**
 * The dump as the node model verify.mjs builds from metadata XML: `{ tag, id, name, x, y, w, h,
 * hidden, children }`, positions relative to the parent. Unlike get_metadata, instances keep
 * their children, so the text inside a navbar or a card component has a box too.
 */
export function dumpTree(dump) {
  const walk = (n, parent) => {
    const b = n.bounds;
    const inGroup = parent && GROUPS.has(parent.type);
    return {
      tag: tagOf(n), id: n.id, name: n.name ?? "",
      x: inGroup ? b.x - parent.bounds.x : b.x, y: inGroup ? b.y - parent.bounds.y : b.y, w: b.width, h: b.height,
      hidden: n.styles?.visible === false,
      children: (n.children ?? []).map((c) => walk(c, n)),
    };
  };
  return walk(dump, null);
}

/** The words of every TEXT node, by id. */
export function dumpWords(dump) {
  const words = new Map();
  const walk = (n) => {
    if (n.type === "TEXT" && typeof n.characters === "string") words.set(n.id, n.characters);
    for (const c of n.children ?? []) walk(c);
  };
  walk(dump);
  return words;
}

const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The dump as get_metadata XML. Positions keep Figma's full precision and instances are written
 * without their children, as get_metadata writes them, so the layout measured from either source
 * is the same; rounding first would turn a 16px gap between fractional boxes into 15.99. The root carries
 * `source="figma-bridge"`, which tells a written file from one saved off the official MCP.
 */
export function dumpToMetadataXml(dump) {
  const lines = [];
  const walk = (n, depth) => {
    const pad = "  ".repeat(depth);
    const head = `${pad}<${n.tag} id="${attr(n.id)}" name="${attr(n.name)}" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}"${n.hidden ? ' hidden="true"' : ""}${depth ? "" : ' source="figma-bridge"'}`;
    if (!n.children.length || n.tag === "instance") {
      lines.push(`${head} />`);
      return;
    }
    lines.push(`${head}>`);
    for (const c of n.children) walk(c, depth + 1);
    lines.push(`${pad}</${n.tag}>`);
  };
  walk(dumpTree(dump), 0);
  return `${lines.join("\n")}\n`;
}
