import calendly from "@/assets/service/webflow/integrations/calendly.svg";
import intercom from "@/assets/service/webflow/integrations/intercom.svg";
import crisp from "@/assets/service/webflow/integrations/crisp.png";
import googleAnalytics from "@/assets/service/webflow/integrations/google-analytics.svg";
import hotjar from "@/assets/service/webflow/integrations/hotjar.svg";
import hubspot from "@/assets/service/webflow/integrations/hubspot.svg";
import salesforce from "@/assets/service/webflow/integrations/salesforce.svg";
import mailchimp from "@/assets/service/webflow/integrations/mailchimp.svg";
import klaviyo from "@/assets/service/webflow/integrations/klaviyo.svg";
import weglot from "@/assets/service/webflow/integrations/weglot.png";
import tagManager from "@/assets/service/webflow/integrations/tag-manager.svg";
import memberstack from "@/assets/service/webflow/integrations/memberstack.svg";
import stripe from "@/assets/service/webflow/integrations/stripe.svg";
import algolia from "@/assets/service/webflow/integrations/algolia.svg";
import finsweet from "@/assets/service/webflow/integrations/finsweet.png";
import zapier from "@/assets/service/webflow/integrations/zapier.svg";
import make from "@/assets/service/webflow/integrations/make.svg";

/** Filter tabs of the integrations grid. The first one shows every card. */
export const integrationTabs = ["All", "Embed", "Analytics", "CRM"];

/** Tools a Webflow build connects to, in the order Figma shows them. Tabs follow the live site. */
export const integrations = [
  { name: "Calendly", text: "Booking", logo: calendly, tabs: ["Embed"] },
  { name: "Intercom", text: "Live chat", logo: intercom, tabs: ["Embed"] },
  { name: "Crisp", text: "Live chat", logo: crisp, tabs: ["Embed"] },
  { name: "Google Analytics", text: "Analytics", logo: googleAnalytics, tabs: ["Analytics"] },
  { name: "Hotjar", text: "Heatmaps", logo: hotjar, tabs: ["Analytics"] },
  { name: "HubSpot", text: "CRM routing", logo: hubspot, tabs: ["CRM"] },
  { name: "Salesforce", text: "CRM routing", logo: salesforce, tabs: ["CRM"] },
  { name: "Mailchimp", text: "Email marketing", logo: mailchimp, tabs: ["CRM"] },
  { name: "Klaviyo", text: "Email automation", logo: klaviyo, tabs: ["CRM"] },
  { name: "Weglot", text: "Multi-language", logo: weglot, tabs: ["Embed"] },
  { name: "Tag Manager", text: "Custom events", logo: tagManager, tabs: ["Analytics"] },
  { name: "Memberstack", text: "Gated content", logo: memberstack, tabs: ["Embed"] },
  { name: "Stripe", text: "Payments", logo: stripe, tabs: ["Embed"] },
  { name: "Algolia", text: "Site search", logo: algolia, tabs: ["Embed"] },
  { name: "Finsweet", text: "Filters", logo: finsweet, tabs: ["Embed"] },
  { name: "Zapier", text: "Automations", logo: zapier, tabs: ["Embed"] },
  { name: "Make", text: "Automations", logo: make, tabs: ["Embed"] },
];
