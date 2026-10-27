"""Built-in DEMO figures for the executive report, mirroring the sample data the dashboard shows when no Search Console data is synced
(seo-dashboard/app/lib/decaySample.ts and lib/cannibalization.ts). A report made from these is labelled DEMO DATA on every page."""

from decay_router import MetricRow

# (url, query, impressions, clicks, average_position) for two 30-day windows
_PREVIOUS = [
    ("/blog/mql-vs-sql-guide", "what is mql vs sql", 4200, 310, 3.1),
    ("/blog/mql-vs-sql-guide", "mql sql difference", 2500, 150, 4.2),
    ("/blog/saas-pricing-models", "saas pricing models", 5200, 420, 3.8),
    ("/blog/saas-pricing-models", "usage based pricing", 1800, 90, 6.0),
    ("/blog/b2b-lead-scoring", "lead scoring model", 3100, 200, 5.0),
    ("/blog/abm-playbook", "account based marketing", 6000, 380, 4.5),
    ("/blog/old-webinar-recap", "b2b webinar tips", 900, 25, 9.0),
    ("/pricing", "crm pricing", 8000, 700, 2.9),
    ("/blog/tiny-post", "niche term", 120, 6, 7.0),
]
_CURRENT = [
    ("/blog/mql-vs-sql-guide", "what is mql vs sql", 1700, 90, 7.4),
    ("/blog/mql-vs-sql-guide", "mql sql difference", 1300, 60, 8.0),
    ("/blog/saas-pricing-models", "saas pricing models", 3900, 260, 5.6),
    ("/blog/saas-pricing-models", "usage based pricing", 1500, 70, 6.9),
    ("/blog/b2b-lead-scoring", "lead scoring model", 2900, 170, 5.3),
    ("/blog/abm-playbook", "account based marketing", 2600, 120, 8.8),
    ("/pricing", "crm pricing", 8200, 720, 2.8),
    ("/blog/tiny-post", "niche term", 20, 0, 12.0),
]

DEMO_PERIOD_DAYS = 30


def _rows(data) -> list[MetricRow]:
    return [MetricRow(url=u, query=q, impressions=i, clicks=c, average_position=p) for u, q, i, c, p in data]


def demo_decay_rows() -> tuple[list[MetricRow], list[MetricRow]]:
    """(previous, current) as the decay engine expects them."""
    return _rows(_PREVIOUS), _rows(_CURRENT)


# (query, page, clicks, impressions, ctr, position): the same tuple layout the synced Search Console rows use
_CANNIBAL = [
    ("enterprise cloud migration", "/services/cloud-migration-framework", 0, 480, 0.0, 4.2),
    ("enterprise cloud migration", "/services/enterprise-cloud-migration", 0, 320, 0.0, 7.8),
    ("account based marketing platform", "/solutions/abm-automation", 0, 150, 0.0, 5.1),
    ("account based marketing platform", "/blog/what-is-abm-software", 0, 80, 0.0, 11.4),
    ("lead scoring model examples", "/blog/lead-scoring-frameworks", 0, 45, 0.0, 8.5),
    ("lead scoring model examples", "/resources/b2b-lead-scoring-guide", 0, 25, 0.0, 14.2),
    ("crm pricing", "/en-us/pricing", 0, 90, 0.0, 3.1),
    ("crm pricing", "/en-gb/pricing", 0, 70, 0.0, 3.8),
    ("hubspot sync guide", "/blog/hubspot-sync-guide", 0, 600, 0.0, 1.4),
    ("hubspot sync guide", "/blog/hubspot-integration-setup", 0, 300, 0.0, 2.6),
    ("abm tools list", "/blog/abm-tools", 0, 15, 0.0, 9.0),
    ("abm tools list", "/blog/abm-software", 0, 12, 0.0, 12.0),
    ("b2b saas demand generation", "/solutions/demand-generation", 0, 48200, 0.0, 2.1),
    ("hubspot crm integration", "/integrations/hubspot", 0, 27400, 0.0, 1.8),
]


def demo_cannibalization_rows() -> list[tuple]:
    return list(_CANNIBAL)
