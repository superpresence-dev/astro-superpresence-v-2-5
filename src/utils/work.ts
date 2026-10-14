import type { CollectionEntry } from "astro:content";

/** URL of the case study listing. Detail and page URLs build on it. */
export const WORK_URL = "/work";

/** URL of one case study. */
export const workUrl = (id: string) => `${WORK_URL}/${id}`;

/** Case studies in their set order. */
export const sortWorks = (works: CollectionEntry<"work">[]) =>
  works.sort((a, b) => a.data.order - b.data.order);
