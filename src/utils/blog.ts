import type { CollectionEntry } from "astro:content";
import { BLOG_CATEGORIES } from "@/content.config.ts";
import { slug } from "@/utils/slug.ts";

/** URL of the blog index. Category and page URLs build on it. */
export const BLOG_URL = "/blog";

/** Posts shown per page on the blog index and category pages. */
export const BLOG_PAGE_SIZE = 15;

/** URL of a category's first page. */
export const blogCategoryUrl = (category: string) =>
  `${BLOG_URL}/category/${slug(category)}`;

/** Category tab links, "All" first. Used by the blog index and category pages. */
export const blogCategoryLinks = () => [
  { label: "All blog post", href: BLOG_URL },
  ...BLOG_CATEGORIES.map((category) => ({
    label: category,
    href: blogCategoryUrl(category),
  })),
];

/** All posts, newest first. */
export const sortPosts = (posts: CollectionEntry<"blog">[]) =>
  posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

/** URL of one post. */
export const blogPostUrl = (id: string) => `${BLOG_URL}/${id}`;
