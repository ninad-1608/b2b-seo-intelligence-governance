"""Mastek 4-Factor Opportunity Scoring.

Score = ((Business Priority * 0.20) + (First-Party Evidence * 0.30)
         + (Ranking Opportunity * 0.30) + (Query-to-URL Evidence * 0.20)) / 5.0 * 100

Each factor is rated 1-5. A composite score of 65 or higher is "High Priority".
Weights are held as integer percentages so the arithmetic is exact (no float drift at the threshold).
"""
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/v1", tags=["Opportunity Scoring"])

HIGH_PRIORITY_THRESHOLD = 65
MAX_RATING = 5

# key, label, weight in percent
FACTORS = (
    ("business_priority", "Business Priority", 20),
    ("first_party_evidence", "First-Party Evidence", 30),
    ("ranking_opportunity", "Ranking Opportunity", 30),
    ("query_url_evidence", "Query-to-URL Evidence", 20),
)
assert sum(w for _, _, w in FACTORS) == 100


class FactorRatings(BaseModel):
    business_priority: int = Field(ge=1, le=MAX_RATING)
    first_party_evidence: int = Field(ge=1, le=MAX_RATING)
    ranking_opportunity: int = Field(ge=1, le=MAX_RATING)
    query_url_evidence: int = Field(ge=1, le=MAX_RATING)


class OpportunityIn(FactorRatings):
    id: int | str


class BatchRequest(BaseModel):
    opportunities: list[OpportunityIn] = Field(max_length=500)


def score_opportunity(r: FactorRatings) -> dict:
    """Return the normalized score, High Priority flag and per-factor breakdown."""
    # (rating * weight% / 5) is each factor's contribution on the 0-100 scale; they sum to the score.
    numerator = sum(getattr(r, key) * weight for key, _, weight in FACTORS)  # == score * 5, exact integer
    score = numerator / MAX_RATING
    return {
        "score": round(score, 1),
        "high_priority": numerator >= HIGH_PRIORITY_THRESHOLD * MAX_RATING,
        "threshold": HIGH_PRIORITY_THRESHOLD,
        "factors": [
            {
                "key": key,
                "label": label,
                "rating": getattr(r, key),
                "max_rating": MAX_RATING,
                "weight": weight / 100,
                "weight_pct": weight,
                "contribution": round(getattr(r, key) * weight / MAX_RATING, 1),
                "max_contribution": float(weight),
            }
            for key, label, weight in FACTORS
        ],
    }


@router.post("/score-opportunity")
async def score_one(data: FactorRatings):
    """Score a single opportunity from its four 1-5 factor ratings."""
    return {"status": "success", **score_opportunity(data)}


@router.post("/score-opportunities")
async def score_many(data: BatchRequest):
    """Score a batch of opportunities; results carry the caller's `id`."""
    return {
        "status": "success",
        "threshold": HIGH_PRIORITY_THRESHOLD,
        "results": [{"id": o.id, **score_opportunity(o)} for o in data.opportunities],
    }
