import type { SvgComponent } from "astro/types";

/** URL of one industry page. */
export const industryUrl = (id: string) => `/industries/${id}`;

const iconFiles = import.meta.glob<{ default: SvgComponent }>(
  "/src/assets/industries/icons/*.svg",
  { eager: true },
);

/** Industry icons by file name, for the `icon` field of the industries collection. */
export const industryIcons: Record<string, SvgComponent> = Object.fromEntries(
  Object.entries(iconFiles).map(([path, file]) => [
    path.slice(path.lastIndexOf("/") + 1, -".svg".length),
    file.default,
  ]),
);
