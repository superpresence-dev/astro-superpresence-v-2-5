import { defineHastPlugin, type PluginFactoryContext } from "satteri";
import type { Element, ElementContent, Root, RootContent } from "hast";

/** Plain copy of a node: Sätteri hands out lazy proxies that cannot be cloned. */
const copy = (node: RootContent): RootContent => {
  const out: Record<string, unknown> = { type: node.type };
  if ("value" in node) out.value = node.value;
  if ("tagName" in node) out.tagName = node.tagName;
  if ("properties" in node) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]),
    );
  }
  if ("children" in node) out.children = node.children.map(copy);
  return out as unknown as RootContent;
};

/** Figma type style for each Markdown heading level. */
const HEADING_STYLE: Record<string, string> = { h2: "h4", h3: "h5", h4: "h6" };

/**
 * Groups the Markdown in `src/content/legal` the way the Figma legal pages
 * are drawn: each `h2` opens a `.legal-section`, and each `h3` or `h4` opens a
 * `.legal-sub` with its own block padding. A table gets a `.legal-table`
 * wrapper so it can scroll sideways on narrow screens. Other Markdown is
 * left out of the plugin.
 *
 * The Markdown level picks the look (`##` H4, `###` H5, `####` H6, as in
 * Figma) through a `.legal-heading-*` class, while the tag is renumbered so
 * the outline never skips a level: a `####` straight under a `##` becomes an
 * `h3` that still looks like H6.
 */
const legalSections = defineHastPlugin({
  name: "legal-sections",
  after(root, ctx) {
    const group = (className: string): Element => ({
      type: "element",
      tagName: "div",
      properties: { className: [className] },
      children: [],
    });

    const sections: Element[] = [];
    let section: Element | undefined;
    let sub: Element | undefined;
    let subSub: Element | undefined;

    for (const node of root.children as RootContent[]) {
      if (node.type === "text" && !node.value.trim()) continue;
      const tag = node.type === "element" ? node.tagName : undefined;

      if (tag === "h2" || !section) {
        section = group("legal-section");
        sections.push(section);
        sub = subSub = undefined;
      }
      if (tag === "h3") {
        sub = group("legal-sub");
        subSub = undefined;
        section.children.push(sub);
      } else if (tag === "h4") {
        subSub = group("legal-sub");
        (sub ?? section).children.push(subSub);
      }

      let content = copy(node) as ElementContent;
      if (tag && tag in HEADING_STYLE && content.type === "element") {
        content.properties.className = [
          `legal-heading-${HEADING_STYLE[tag]}`,
        ];
        if (tag === "h4" && !sub) content.tagName = "h3";
      }
      if (tag === "table") {
        const wrap = group("legal-table");
        wrap.children.push(content);
        content = wrap;
      }
      (subSub ?? sub ?? section).children.push(content);
    }

    ctx.replaceNode(root, { type: "root", children: sections } as Root);
  },
});

/** Runs the plugin only for files under `src/content/legal`. */
export default function legalSectionsPlugin({ fileURL }: PluginFactoryContext) {
  return fileURL?.pathname.includes("/content/legal/") ? legalSections : null;
}
