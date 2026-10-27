"""Sandbox page inventory for the Internal Link Opportunity Finder (replace with a real crawl via CSV upload)."""

SANDBOX_PAGES: list[dict] = [
    {
        "url": "/blog/lead-scoring-frameworks",
        "title": "Lead Scoring Frameworks for B2B SaaS Teams",
        "keywords": "lead scoring, lead scoring model",
        "content": (
            "Lead scoring assigns points to prospects based on fit and behavior so sales can focus on the best leads. "
            "A good lead scoring model combines firmographic data with engagement signals such as demo requests and pricing page visits. "
            "Once a prospect crosses the threshold they become a marketing qualified lead and move toward sales. "
            "Most teams sync scores to their CRM and review the model every quarter. Demand generation programs depend on accurate scoring to prove pipeline impact."
        ),
        "outlinks": ["/blog/mql-vs-sql-guide"],
    },
    {
        "url": "/blog/mql-vs-sql-guide",
        "title": "MQL vs SQL: What Is the Difference?",
        "keywords": "mql vs sql, marketing qualified lead, sales qualified lead",
        "content": (
            "A marketing qualified lead has shown enough interest to be worth nurturing, while a sales qualified lead is ready for a sales conversation. "
            "The handoff between marketing and sales should be defined by a shared lead scoring threshold and clear service levels. "
            "Sales enablement content such as battlecards helps reps follow up on every MQL. Agree on definitions before you configure the CRM."
        ),
        "outlinks": ["/blog/lead-scoring-frameworks", "/solutions/demand-generation", "/products/sales-enablement"],
    },
    {
        "url": "/solutions/demand-generation",
        "title": "B2B SaaS Demand Generation Services",
        "keywords": "demand generation, b2b demand generation",
        "content": (
            "Our B2B demand generation programs build qualified pipeline through content, webinars and paid media. "
            "We combine account based marketing with lead scoring so sales receives prospects that match your ideal customer profile. "
            "Every campaign is tracked in your CRM from first touch to closed revenue."
        ),
        "outlinks": ["/solutions/abm-automation"],
    },
    {
        "url": "/solutions/abm-automation",
        "title": "Account Based Marketing Platform",
        "keywords": "account based marketing, abm platform, abm software",
        "content": (
            "Our account based marketing platform lets teams target named accounts with personalized campaigns across channels. "
            "Intent data highlights the accounts that are researching your category, and sales alignment workflows route them to the right rep. "
            "The platform syncs with your CRM so every account touchpoint is reported in one place."
        ),
        "outlinks": ["/integrations/hubspot"],
    },
    {
        "url": "/blog/what-is-abm-software",
        "title": "What Is ABM Software?",
        "keywords": "abm software, account based marketing software",
        "content": (
            "ABM software helps B2B teams run account based marketing at scale by identifying target accounts, orchestrating campaigns and measuring engagement. "
            "Unlike broad demand generation, account based marketing focuses budget on a short list of high value accounts. "
            "Look for intent data, CRM integration and account level reporting when you compare an ABM platform."
        ),
        "outlinks": [],
    },
    {
        "url": "/integrations/hubspot",
        "title": "HubSpot CRM Integration",
        "keywords": "hubspot crm integration, hubspot integration",
        "content": (
            "The HubSpot CRM integration syncs leads, lifecycle stages and lead scoring properties in both directions. "
            "Workflows update an MQL to an SQL automatically when the score passes your threshold, and dashboards show pipeline by campaign. "
            "Setup takes minutes and requires no developer time."
        ),
        "outlinks": ["/blog/lead-scoring-frameworks"],
    },
    {
        "url": "/products/sales-enablement",
        "title": "Sales Enablement Software",
        "keywords": "sales enablement software, sales enablement",
        "content": (
            "Sales enablement software gives reps a content library, playbooks and battlecards in one place. "
            "Marketing publishes assets that sales can find fast, and analytics show which content helps close deals. "
            "Integrates with your CRM so reps see the right material for every opportunity, from the first MQL follow up to the final proposal."
        ),
        "outlinks": ["/integrations/hubspot"],
    },
    {
        "url": "/pricing",
        "title": "Pricing",
        "keywords": "saas pricing",
        "content": (
            "Choose a plan that fits your team. Per seat pricing starts at a flat monthly fee, and usage based pricing is available for high volume accounts. "
            "All plans include CRM integrations, reporting and onboarding support."
        ),
        "outlinks": ["/blog/b2b-saas-pricing-models"],
    },
    {
        "url": "/blog/b2b-saas-pricing-models",
        "title": "B2B SaaS Pricing Models Explained",
        "keywords": "saas pricing models, usage based pricing, per seat pricing",
        "content": (
            "The most common SaaS pricing models are per seat pricing, usage based pricing and tiered plans. "
            "Per seat pricing is simple to forecast, while usage based pricing aligns cost with value for high volume customers. "
            "Test your pricing page with real buyers before you commit to a model, and review it every year."
        ),
        "outlinks": ["/pricing"],
    },
    {
        "url": "/services/cloud-migration-framework",
        "title": "Enterprise Cloud Migration Framework",
        "keywords": "enterprise cloud migration, cloud migration framework",
        "content": (
            "Our enterprise cloud migration framework covers assessment, workload planning, security controls and cost governance. "
            "We move applications with lift and shift or re-architecture depending on business value, and validate every cutover with rollback plans."
        ),
        "outlinks": ["/blog/how-to-migrate-enterprise-cloud"],
    },
    {
        "url": "/blog/how-to-migrate-enterprise-cloud",
        "title": "How to Migrate to the Cloud: Enterprise Guide",
        "keywords": "enterprise cloud migration, cloud migration strategy",
        "content": (
            "A successful enterprise cloud migration starts with an inventory of workloads, dependencies and compliance needs. "
            "Choose a migration strategy for each application, set cost guardrails and plan security from day one. "
            "Pilot a low risk workload first, then scale the cloud migration in waves."
        ),
        "outlinks": ["/services/cloud-migration-framework"],
    },
    {
        "url": "/blog/old-webinar-recap",
        "title": "B2B Webinar Tips and Recap",
        "keywords": "b2b webinar, webinar tips",
        "content": (
            "Webinars remain one of the best demand generation channels for B2B teams. "
            "Promote early, follow up within a day and use lead scoring to separate casual attendees from real buyers. "
            "Our recap shares registration rates, attendance benchmarks and the follow up sequence that moved attendees into pipeline."
        ),
        "outlinks": [],
    },
    {
        "url": "/glossary/mql",
        "title": "MQL Glossary Definition",
        "keywords": "mql, marketing qualified lead definition",
        "content": (
            "An MQL, or marketing qualified lead, is a prospect whose lead scoring result shows they are more likely to become a customer than other leads. "
            "Marketing passes MQLs to sales once they reach an agreed threshold."
        ),
        "outlinks": [],
    },
]
