/** Base URL of the service pages. Each service is its own page under it. */
export const SERVICE_URL = "/service";

/** Service pages built so far, by the name the nav and footer show. */
const serviceSlugs: Record<string, string> = {
  "Website design": "website-design",
  "Webflow development": "webflow-development",
  "Migrate to Webflow": "migrate-to-webflow",
  Branding: "branding",
  "Webflow maintenance": "webflow-maintenance",
  "Social & ad creative": "social-ad-creative",
};

/** URL of a service by its name, or `#` while its page is not built. */
export const serviceUrl = (name: string) =>
  serviceSlugs[name] ? `${SERVICE_URL}/${serviceSlugs[name]}` : "#";
