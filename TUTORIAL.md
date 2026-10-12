# Tutorial: from Figma to a working Lumos site

This template turns Figma designs into fixed values per breakpoint, so the site matches the design instead of scaling fluidly. An AI agent does the measuring; you provide the design data and answer its questions.

| Breakpoint | Width |
| --- | --- |
| mobile | up to 767px |
| tablet | 768–991px |
| desktop | 992px and up |

## Part 1: One-time setup

### 1. Create your project

```bash
gh repo create my-project --template myuzara02/astro-lumos-custom --clone
cd my-project
npm install
```

(Or click **Use this template** on the GitHub page.) The colors and sizes that ship with the template belong to the design it was built from. Part 2 replaces them with yours.

### 2. Connect Figma to your AI agent

Any AI coding agent that supports MCP servers works (the skill is plain Markdown plus a Node script; `AGENTS.md` is the shared instruction file most agents read).

1. Open the Figma desktop app and your design file, then switch to **Dev Mode**.
2. Turn on the **MCP server** in the right-hand panel. Figma shows its address, normally `http://127.0.0.1:3845/mcp`.
3. Register that address as an **HTTP MCP server** in your agent's MCP settings, named for example `figma-desktop`. The setting lives in a different place in each agent (a config file or a CLI command such as `mcp add`); check your agent's MCP documentation. The generic shape is:
   ```json
   { "mcpServers": { "figma-desktop": { "type": "http", "url": "http://127.0.0.1:3845/mcp" } } }
   ```
4. Reload or restart the agent, then confirm it lists Figma tools such as `get_metadata` and `get_design_context`.

Keep Figma desktop open while you work. Figma's remote server (`mcp.figma.com`) needs an OAuth login that some agents cannot complete, so the desktop server is the dependable choice.

## Part 2: For every new design

### Step 1. Export your variables

1. In Figma, open the plugin **[Export/Import Variables](https://www.figma.com/community/plugin/1256972111705530093/export-import-variables)**.
2. Export each variable collection as JSON (for example the responsive collection with desktop/tablet/mobile modes, and the static one with colors and fonts).

Menu labels in the plugin may differ slightly; what matters is one JSON file per collection.

### Step 2. Drop everything into `figma/`

Put the exported JSON files in the `figma/` folder at the project root. File names do not matter, because files are recognised by what is inside them. Everything in `figma/` except its README stays out of git, so your design data is never published.

### Step 3. Tell the agent

Say it in your own words. Mentioning Figma, the `figma/` folder, or words like *implement*, *slice*, *kerjakan* or *eksekusi* makes the agent load the `lumos-import-figma` skill first (this rule is in `AGENTS.md`). To be safe, name the skill:

> Use the lumos-import-figma skill. Read the figma folder, show me the report, ask me about anything unclear, and only then update `base.css`.

With a Figma link instead of files:

> Use the lumos-import-figma skill. Implement this page: &lt;Figma link&gt;

For a link, the agent saves the page's layout data (and text styles for each frame) into `figma/` itself, then analyses everything. Figma desktop must be open.

### Step 4. Answer its questions

The agent prints one report and one list of questions, for example:

- values that differ from the template (a heading weight, letter spacing),
- which section-padding size a measured value belongs to (small, medium, large),
- fonts that are not set up yet.

It never changes `src/` until you have answered. It also never invents a new token to hide an inconsistency in the design.

### Step 5. Check the result

```bash
npx astro dev --background     # start the site (stop with: npx astro dev stop)
npx astro check                # type check
```

Open the page and resize the browser across 767/768px and 991/992px; sizes should jump at those points. Then compare with the Figma screenshot at 1440, 834 and 393px. A mismatch is usually an inconsistency in the design (a question), not a bug.

## What the agent measures

| From | What | How |
| --- | --- | --- |
| Variable files | font sizes, line heights, spacing, radius, icon sizes, colors | compared with `src/styles/base.css` |
| Page layout data | side margin, column gap, section padding | measured from node positions |
| Text styles | font weight, letter spacing, uppercase | read from each frame's design context |
| Fonts | family and weights | compared with `astro.config.mjs` |

Line height, weight and letter spacing can only be found while slicing, because variables do not say which text style uses which weight or tracking. Nothing is applied or skipped silently: each difference is reported and asked about.

## Commands (the agent runs these; you can too)

```bash
npm run slice -- --folder figma                  # read everything in figma/
npm run slice -- --metadata page.xml             # layout of one page
npm run slice -- --design-context frame.txt      # text styles of one frame
npm run slice -- --variables a.json b.json       # variable files only
npm run slice -- --summary frame.txt             # compact outline of a design context
npm run slice -- --px 30                         # nearest spacing token
npm run slice -- --lh 36/32                      # line height 36 on a 32px font
npm run slice -- --color "#FFFFFF@60"            # color with opacity
```

`npm run slice` runs `.agents/skills/lumos-import-figma/convert.mjs`. (`convert` on its own is not a shell command.)

## How the tokens work

Every responsive value in `src/styles/base.css` has three numbers:

```css
--h1-mobile: 32;
--h1-tablet: 45;
--h1-desktop: 54;
```

Changing the design means changing numbers, never the formula. Spacing, radius and icon tokens use Figma's names (`--space-1-5rem`, `--radius-0-5rem`, `--icon-m`). Colors have two layers: palette values (`--color-neutral-10`) and theme roles (`--background`, `--text`, `--brand`). Leading text trim is off; turn it on with the `.text-trim` class.

Build pages from components (`Section`, `ContentWrapper`, `Heading`, `Paragraph`); see `LUMOS.md`.

## Customising without side effects: role tokens

Each project can change these independently and everything stays aligned. Defaults are neutral, so the template looks unchanged until you set them.

| Token | What it controls |
| --- | --- |
| `--text` | body copy colour |
| `--heading` | heading colour (h1–h6, display); defaults to `--text` |
| `--ui` | strokes, selection, focus outline and hover fills; defaults to `--text`, so changing body colour does not tint borders or focus rings |
| `--button-radius`, `--button-padding-block`, `--button-padding-inline`, `--button-gap`, `--button-font-size`, `--button-font-weight`, `--button-line-height`, `--button-letter-spacing`, `--button-border-inset` | the shape and type of every button |
| `--button-background`, `--button-text`, `--button-border` (and the `-2` secondary set) | button colours, defined in every theme block |

Utility classes `.weight-regular`, `.weight-medium` and `.weight-semibold` cover body weight variants. The skill reports differences for all of these (text colours, shadows, buttons, fixed or clipped nodes, assets) and asks before anything is applied.

## Fonts

Figma's "Inter Display" is Inter at optical size 32. The template loads it from Google Fonts with weights 400–700 (`astro.config.mjs`), so it needs an internet connection at dev and build time. For another font, change `name`, `weights` and `variableAxis` there; for a licensed font use `fontProviders.local()` with one `variants` entry per weight. The agent tells you when a font or weight from Figma is not configured.

## Updating an older project

A project made from the template is a copy, so later template changes do not arrive on their own. To bring in the newest tooling, replace `.agents/skills/lumos-import-figma` as a whole, and copy the `slice` and `verify` scripts in `package.json` and the rule in `AGENTS.md` from the template.

Replace the folder, do not copy over it, or a file the template deleted or renamed stays behind. From a project that has the template as a remote named `template`:

```bash
git fetch template
git rm -r --quiet .agents/skills/lumos-import-figma
git restore --source=template/main --worktree --staged -- .agents/skills/lumos-import-figma
```

Never change the tool inside a project. Fix it in the template, test it on a sample design, then pull it into the project.

## Maintaining the template with two remotes

If the template lives on two remotes whose histories differ on purpose (a personal repo and an organisation repo that must show only the organisation account), a plain `git push` to the second one is rejected and `--force` would wipe its history. Use `scripts/push-both.sh` instead: it pushes `main` as it is to the first remote, re-authors the new commits on top of the second remote's history, pushes them as a normal fast-forward, and restores your active `gh` account. Run `scripts/push-both.sh --dry-run` first to see what it would do. It needs a `.push-both.env` (git-ignored) with the remote names, the `gh` logins and the author identity for the second remote; the variables are listed at the top of the script.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Figma tools do not appear in the agent | Reload or restart the agent. Check that Figma desktop is open with its MCP server on and that the address in the agent matches the one Figma shows. |
| The agent reports "OAuth authorization failed" for Figma | You are using Figma's remote server. Switch to the desktop server (Part 1, step 2). |
| Headings look Regular instead of Bold | The weight is not loaded. Check `weights` in `astro.config.mjs`. |
| Section padding differs between tablet and the variable | The designer used different variables per frame. The agent measures positions, which are the source of truth. |
| Some sections report "not measurable" | They are component instances or have no children in the layout data. The agent reads them from the design context instead. |
| Button text looks taller than the design | Trim is off on purpose to follow Figma's line box. Add `.text-trim` if you want it. |
