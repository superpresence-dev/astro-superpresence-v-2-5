// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { SITE_URL } from "./src/consts.ts";
import { isNoindexRoute } from "./src/utils/seo.ts";
import { satteri } from "@astrojs/markdown-satteri";
import legalSections from "./src/utils/legal-sections.ts";

export default defineConfig({
  site: SITE_URL,
  redirects: {
    "/resources": "/exploration",
  },
  integrations: [
    sitemap({
      filter: (page) => !isNoindexRoute(new URL(page).pathname),
    }),
  ],
  markdown: { processor: satteri({ hastPlugins: [legalSections] }) },
  fonts: [
    {
      name: "Stack Sans Headline",
      cssVariable: "--font-stack-sans-headline",
      provider: fontProviders.google(),
      weights: ["500", "600"],
      styles: ["normal"],
    },
  ],
  vite: { build: { cssTarget: "safari15.4" } },
});
