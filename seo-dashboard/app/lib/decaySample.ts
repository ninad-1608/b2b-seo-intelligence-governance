// Sandbox GSC data for two 30-day windows. Replace with real exports when available.
export type DecayRow = {
  url: string;
  query: string;
  impressions: number;
  clicks: number;
  average_position: number;
};

export const previousWindow: DecayRow[] = [
  { url: "/blog/mql-vs-sql-guide", query: "what is mql vs sql", impressions: 4200, clicks: 310, average_position: 3.1 },
  { url: "/blog/mql-vs-sql-guide", query: "mql sql difference", impressions: 2500, clicks: 150, average_position: 4.2 },
  { url: "/blog/saas-pricing-models", query: "saas pricing models", impressions: 5200, clicks: 420, average_position: 3.8 },
  { url: "/blog/saas-pricing-models", query: "usage based pricing", impressions: 1800, clicks: 90, average_position: 6.0 },
  { url: "/blog/b2b-lead-scoring", query: "lead scoring model", impressions: 3100, clicks: 200, average_position: 5.0 },
  { url: "/blog/abm-playbook", query: "account based marketing", impressions: 6000, clicks: 380, average_position: 4.5 },
  { url: "/blog/old-webinar-recap", query: "b2b webinar tips", impressions: 900, clicks: 25, average_position: 9.0 },
  { url: "/pricing", query: "crm pricing", impressions: 8000, clicks: 700, average_position: 2.9 },
  { url: "/blog/tiny-post", query: "niche term", impressions: 120, clicks: 6, average_position: 7.0 },
];

export const currentWindow: DecayRow[] = [
  { url: "/blog/mql-vs-sql-guide", query: "what is mql vs sql", impressions: 1700, clicks: 90, average_position: 7.4 },
  { url: "/blog/mql-vs-sql-guide", query: "mql sql difference", impressions: 1300, clicks: 60, average_position: 8.0 },
  { url: "/blog/saas-pricing-models", query: "saas pricing models", impressions: 3900, clicks: 260, average_position: 5.6 },
  { url: "/blog/saas-pricing-models", query: "usage based pricing", impressions: 1500, clicks: 70, average_position: 6.9 },
  { url: "/blog/b2b-lead-scoring", query: "lead scoring model", impressions: 2900, clicks: 170, average_position: 5.3 },
  { url: "/blog/abm-playbook", query: "account based marketing", impressions: 2600, clicks: 120, average_position: 8.8 },
  { url: "/pricing", query: "crm pricing", impressions: 8200, clicks: 720, average_position: 2.8 },
  { url: "/blog/tiny-post", query: "niche term", impressions: 20, clicks: 0, average_position: 12.0 },
];
