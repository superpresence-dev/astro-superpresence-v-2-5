// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { SITE_URL } from "./src/consts.ts";
import { isNoindexRoute } from "./src/utils/seo.ts";

export default defineConfig({
  site: SITE_URL,
  integrations: [
    sitemap({
      filter: (page) => !isNoindexRoute(new URL(page).pathname),
    }),
  ],
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
