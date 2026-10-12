# Superpresence V2.5

Marketing site for [Superpresence](https://superpresence.co), built with
[Lumos for Astro](https://lumosframework.com) from the Figma file
**Superpresence – V2.5**.

Preview: https://superpresence-v-2-5.astro-lumos-custom.workers.dev

## Status

| Area                           | State                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Homepage sections (hero → CTA) | Built from Figma                                                                                                              |
| Navbar                         | Built from the navbar inside the hero frame; dropdowns and the open mobile menu are not in Figma yet                          |
| Footer                         | Built from Figma node `4771:4822`; newsletter form has no endpoint yet, live clocks for Sydney, Bangkok, Hong Kong, Singapore |
| Value section icons            | One icon used for all four; the four Figma icons still need exporting                                                         |
| FAQ answers 2–8                | Lorem ipsum placeholders                                                                                                      |
| Links                          | Most `href`s are `#`                                                                                                          |
| Helvetica Neue                 | Not loaded yet; falls back to the system Helvetica Neue / Helvetica / Arial                                                   |

## Getting started

Node 22.12 or newer is required.

```sh
npm install
npm run dev
```

| Script            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Starts the dev server at http://localhost:4321            |
| `npm run build`   | Builds the site to `dist/`                                |
| `npm run preview` | Serves the built site                                     |
| `npm run check`   | Type-checks every `.astro` file                           |
| `npm run format`  | Formats the project with Prettier                         |
| `npm run slice`   | Reads the `figma/` folder and reports tokens to reconcile |
| `npm run verify`  | Compares the running page against the Figma frames        |

## Deploying

The site deploys as an assets-only Cloudflare Worker named
`superpresence-v-2-5` (see `wrangler.jsonc`):

```sh
npm run build
npx wrangler deploy
```

## Project structure

```
src/
  assets/home/          Images exported from Figma for the homepage
  assets/icons/         Shared icons (arrow, menu, nav plus…)
  components/content/   Homepage section contents (HomeStat, HomeService…)
  components/section/   Sections styled as a whole (HomeHero, HomeQuote, HomeCta)
  components/global/    Nav and Footer
  pages/index.astro     Homepage
  styles/base.css       Design tokens (type, spacing, colour, shadows, buttons)
```

Tokens are explicit per-breakpoint values: mobile < 768px, tablet 768–991px,
desktop ≥ 992px.

## Working on the design

- Read [LUMOS.md](LUMOS.md) before adding pages, components or styles.
- Figma work goes through the `lumos-import-figma` skill in
  `.agents/skills/`. Put Figma exports in `figma/` (git-ignored) and run
  `npm run slice`.
- Fonts: Stack Sans Headline comes from Google Fonts via `astro.config.mjs`.
  Helvetica Neue needs licensed files in `src/assets/fonts/` and a local
  `fonts` entry.

## License

Built on Lumos for Astro, [MIT](LICENSE).
