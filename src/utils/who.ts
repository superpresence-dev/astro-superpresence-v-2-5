/** URL of one "Who we work with" page. */
export const whoUrl = (id: string) => `/who-we-work-with/${id}`;

/** Audiences in the nav and footer, each with the id of its page. */
export const AUDIENCES: { title: string; id: string }[] = [
  { title: "Startups", id: "startups" },
  { title: "Businesses going digital", id: "businesses-going-digital" },
  { title: "Marketing teams", id: "marketing-teams" },
];
