import type { CollectionEntry } from "astro:content";

/** URL of the explorations gallery. */
export const EXPLORATION_URL = "/exploration";

/** Explorations in their set order. */
export const sortExplorations = (items: CollectionEntry<"explorations">[]) =>
  items.sort((a, b) => a.data.order - b.data.order);
