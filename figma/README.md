# figma/

Drop everything the design gives you in this folder, then say "read the figma folder".

- **Variable exports**: the `Responsive.json` / `Static.json` files exported from Figma (`modes` and `variables`).
- **Page metadata**: the XML that Figma's `get_metadata` returns for a page section holding the desktop, tablet and mobile frames. One file per page.
- **Design context**: the raw `get_design_context` output (with `excludeScreenshot: true`) for each frame, e.g. `about-desktop.txt`. It is the only source of font weight, letter spacing and text-transform per text style.
- **Inventory JSON**: hand-made measurements (`space`, `type`, `color`, `letter`, `radius`, `icon`, `layout`, `weight`).

File names do not matter. Each file is recognised by what is inside it. Anything else is listed as skipped.

One command reads the whole folder and prints one report with one list of questions:

```bash
npm run slice -- --folder figma
```

Nothing in `src/` changes until the questions are answered.
