import { defineCollection, reference } from "astro:content";
import { file, glob } from "astro/loaders";
import { z } from "astro/zod";

/** Blog categories, in the order the category tabs show them. */
export const BLOG_CATEGORIES = [
  "Marketing",
  "CRO",
  "Webflow",
  "Web design",
  "Artificial Intelligence",
] as const;

const work = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/work" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      client: z.string(),
      industry: z.string(),
      thumbnail: image(),
      logo: image(),
      order: z.number(),
      stats: z
        .array(z.object({ value: z.string(), label: z.string() }))
        .default([]),
      gallery: z.array(image()).default([]),
      about: z
        .object({
          description: z.string(),
          website: z.url().optional(),
          country: z.string().optional(),
          teamSize: z.string().optional(),
        })
        .optional(),
    }),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      tag: z.string(),
      category: z.enum(BLOG_CATEGORIES),
      date: z.coerce.date(),
      thumbnail: image(),
      author: reference("authors").optional(),
      takeaways: z
        .array(z.object({ title: z.string(), text: z.string() }))
        .default([]),
    }),
});

/** Exploration categories, in the order the filter tabs show them. */
export const EXPLORATION_CATEGORIES = [
  "Website",
  "Branding",
  "Interaction",
  "Illustration",
  "Print",
] as const;

const explorations = defineCollection({
  loader: file("./src/content/explorations.json"),
  schema: ({ image }) =>
    z.object({
      /** Describes the image; used as its alt text. */
      title: z.string(),
      category: z.enum(EXPLORATION_CATEGORIES),
      image: image(),
      order: z.number(),
    }),
});

const authors = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/authors" }),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      role: z.string(),
      avatar: image(),
      linkedin: z.url().optional(),
    }),
});

const legal = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/legal" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    lastUpdated: z.coerce.date(),
  }),
});

/** Icon names an industry can use: the file names in src/assets/industries/icons. */
const INDUSTRY_ICONS = Object.keys(
  import.meta.glob("/src/assets/industries/icons/*.svg"),
).map((path) => path.slice(path.lastIndexOf("/") + 1, -".svg".length));

const item = z.object({ title: z.string(), text: z.string() });

const industries = defineCollection({
  loader: glob({ pattern: "**/*.yaml", base: "./src/content/industries" }),
  schema: ({ image }) =>
    z.object({
      /** Industry name, used for the page title. */
      title: z.string(),
      description: z.string(),
      order: z.number(),
      hero: z.object({
        eyebrow: z.string(),
        heading: z.string(),
        text: z.string(),
        image: image(),
        /** Colour the bottom fade runs to (hex), when the photo is tinted. Defaults to the neutral dark. */
        fade: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      }),
      problem: z.object({
        heading: z.string(),
        lead: z.string(),
        items: z.array(item),
      }),
      who: z.object({
        heading: z.string(),
        lead: z.string(),
        items: z.array(
          z.object({
            icon: z.string().refine((name) => INDUSTRY_ICONS.includes(name), {
              message: `Unknown icon. Use one of: ${INDUSTRY_ICONS.join(", ")}`,
            }),
            title: z.string(),
            text: z.string().optional(),
          }),
        ),
        note: z.string(),
      }),
      build: z.object({
        heading: z.string(),
        image: image(),
        items: z.array(item),
      }),
      difference: z.object({
        heading: z.string(),
        lead: z.string(),
        without: z.array(z.string()),
        with: z.array(z.string()),
      }),
      process: z.object({
        heading: z.string(),
        steps: z.array(
          z.object({
            title: z.string(),
            text: z.string(),
            points: z.array(z.string()),
          }),
        ),
      }),
      growth: z.object({
        heading: z.string(),
        lead: z.string(),
        items: z.array(item),
        stat: z.object({ value: z.string(), label: z.string() }).optional(),
      }),
      value: z.object({
        heading: z.string(),
        items: z.array(item),
        writerLine: z.string(),
      }),
      quote: z
        .object({
          quote: z.string(),
          name: z.string(),
          jobTitle: z.string(),
          company: z.string(),
          avatar: image(),
          logo: image(),
        })
        .optional(),
      faq: z.object({
        heading: z.string(),
        items: z.array(z.object({ question: z.string(), answer: z.string() })),
      }),
      cta: z.object({ heading: z.string(), text: z.string() }),
    }),
});

/** Pictures a "where you are now" stage can show: the variants of WhoStageGraphic. */
export const WHO_STAGE_VISUALS = [
  "forward",
  "qualify",
  "structure",
  "referral",
  "refresh",
  "expand",
  "match",
  "launch",
  "funnel",
] as const;

/** Pictures a process step can show: the variants of WhoProcessGraphic. */
export const WHO_PROCESS_VISUALS = [
  "interview",
  "pitch",
  "scene",
  "paths",
  "publish",
  "referrer",
  "services",
  "identity",
  "enquiry",
  "people",
  "leaks",
  "variants",
  "kit",
  "form",
  "events",
] as const;

const who = defineCollection({
  loader: glob({ pattern: "**/*.yaml", base: "./src/content/who" }),
  schema: ({ image }) =>
    z.object({
      /** Audience name, used for the page title. */
      title: z.string(),
      description: z.string(),
      order: z.number(),
      hero: z.object({
        eyebrow: z.string(),
        heading: z.string(),
        text: z.string(),
        image: image(),
      }),
      problem: z.object({
        heading: z.string(),
        items: z.array(item),
      }),
      stages: z.object({
        eyebrow: z.string(),
        heading: z.string(),
        lead: z.string(),
        items: z.array(
          z.object({
            /** Text in the side navigation. */
            label: z.string(),
            /** Opening sentence, set darker than the rest of the text. */
            title: z.string(),
            text: z.string(),
            /** Line beside the flag icon, under the text. */
            note: z.string(),
            image: image(),
            visual: z.enum(WHO_STAGE_VISUALS),
          }),
        ),
      }),
      benefits: z.object({ items: z.array(item) }),
      shift: z.object({
        with: z.array(z.string()),
        without: z.array(z.string()),
      }),
      process: z.object({
        heading: z.string(),
        steps: z.array(
          z.object({
            label: z.string(),
            title: z.string(),
            text: z.string(),
            points: z.array(z.string()),
            visual: z.enum(WHO_PROCESS_VISUALS),
          }),
        ),
      }),
      faq: z.object({
        heading: z.string(),
        items: z.array(z.object({ question: z.string(), answer: z.string() })),
      }),
      cta: z.object({ heading: z.string(), text: z.string() }),
    }),
});

export const collections = {
  work,
  blog,
  authors,
  explorations,
  legal,
  industries,
  who,
};
