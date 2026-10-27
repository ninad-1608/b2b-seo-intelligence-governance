"""Predictive traffic & decaying-page forecasting.

Model (deliberately simple and transparent):
  * Position erosion is fitted over the supplied periods, linearly (positions per day) or exponentially (compounding %), and
    projected from the LAST observed position, so day 0 always equals what was actually seen.
  * Clicks follow position through a CTR-by-position curve, scaled to the page's own current clicks:
        clicks(t) = clicks_now * CTR(position(t)) / CTR(position_now)
    Search demand is assumed constant. Clicks that fall for non-position reasons (SERP features, seasonality) are not modelled,
    and the response says so when the history shows it.
  * "Refreshed" is a scenario, not a prediction: after a lag the position recovers part of the way to the best position seen,
    over a ramp, and holds. All of its assumptions are request parameters and echoed in the response.
With only two periods the trend is a straight line between them; confidence is reported accordingly.
"""
import math
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/forecast", tags=["Forecasting"])  # app.py mounts it under /api/v1

HORIZON = 90
POINT_DAYS = (0, 30, 60, 90)
CURVE_STEP = 5
CTR_A, CTR_B = 0.30, 1.135  # CTR(p) = A * p^-B: ~30% at #1 and ~2.2% at #10. Only the SHAPE matters (clicks are anchored to the page's own).
MAX_POSITION = 100.0
DECAY_MIN_PER_PERIOD = 0.2  # positions worse per period before a page counts as decaying
BAND_CONSERVATIVE, BAND_AGGRESSIVE = 0.5, 1.5  # velocity multipliers for the uncertainty band
LOSS_REF, VOLUME_REF = 5_000, 50_000  # clicks lost / monthly demand at which those score components saturate
MIN_CLICKS_FOR_CONFIDENCE = 30


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class Period(BaseModel):
    clicks: float = Field(ge=0, le=1e9)
    position: float = Field(ge=1, le=1000)  # average position
    impressions: float | None = Field(default=None, ge=0, le=1e10)


class Scenario(BaseModel):
    velocity_multiplier: float = Field(default=1.0, ge=0.25, le=3.0)  # 0.5 = conservative, 1 = as fitted, 2 = aggressive
    recovery_pct: float = Field(default=0.6, ge=0.1, le=1.0)  # share of lost ground a refresh wins back (vs the best position seen)
    refresh_lag_days: int = Field(default=14, ge=0, le=60)  # decay continues until the refresh is live and re-crawled
    ramp_days: int = Field(default=30, ge=7, le=90)  # time to reach the recovered position


class PageIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    keyword: str = Field(default="", max_length=200)  # primary keyword
    keyword_volume: float | None = Field(default=None, ge=0, le=1e9)  # monthly searches, if known
    period_days: int = Field(default=28, ge=7, le=120)  # length of each history period
    history: list[Period] = Field(min_length=2, max_length=12)  # oldest -> newest, equal-length periods


class PageDecayRequest(PageIn, Scenario):
    pass


class BatchRequest(Scenario):
    pages: list[PageIn] = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Model pieces (pure functions)
# ---------------------------------------------------------------------------
def ctr(position: float) -> float:
    return CTR_A * max(position, 1.0) ** -CTR_B


def _linear_fit(ts: list[float], ys: list[float]) -> tuple[float, float, float]:
    """(slope, sse, sst) of y = a + slope*t."""
    n = len(ts)
    mt, my = sum(ts) / n, sum(ys) / n
    sxx = sum((t - mt) ** 2 for t in ts)
    slope = sum((t - mt) * (y - my) for t, y in zip(ts, ys)) / sxx
    icpt = my - slope * mt
    sse = sum((y - (icpt + slope * t)) ** 2 for t, y in zip(ts, ys))
    sst = sum((y - my) ** 2 for y in ys)
    return slope, sse, sst


def _exp_fit(ts: list[float], ys: list[float]) -> tuple[float, float]:
    """(g, sse in position space) of y = a * exp(g*t)."""
    logs = [math.log(y) for y in ys]
    g, _, _ = _linear_fit(ts, logs)
    n = len(ts)
    mt, ml = sum(ts) / n, sum(logs) / n
    a = ml - g * mt
    sse = sum((y - math.exp(a + g * t)) ** 2 for t, y in zip(ts, ys))
    return g, sse


def fit_erosion(positions: list[float], period_days: int) -> dict:
    """Choose linear vs exponential erosion. Rates are per DAY."""
    n = len(positions)
    ts = [i * float(period_days) for i in range(n)]
    slope, lin_sse, sst = _linear_fit(ts, positions)
    r2_lin = 1.0 if sst < 1e-9 else max(0.0, 1 - lin_sse / sst)
    model, rate, r2 = "linear", slope, r2_lin
    if n >= 3 and slope > 0:
        g, exp_sse = _exp_fit(ts, positions)
        # prefer the simpler model unless the exponential is clearly better
        if g > 0 and exp_sse < 0.8 * lin_sse:
            model, rate = "exponential", g
            r2 = 1.0 if sst < 1e-9 else max(0.0, 1 - exp_sse / sst)
    last = positions[-1]
    per_period = rate * period_days if model == "linear" else last * (math.exp(rate * period_days) - 1)
    status = "decaying" if per_period > DECAY_MIN_PER_PERIOD else "improving" if per_period < -DECAY_MIN_PER_PERIOD else "stable"
    return {"model": model, "rate_per_day": rate, "per_period": per_period, "r2": r2, "status": status}


def position_at(t: float, last: float, model: str, rate: float, mult: float) -> float:
    p = last + rate * mult * t if model == "linear" else last * math.exp(rate * mult * t)
    return min(MAX_POSITION, max(1.0, p))


def acceleration(positions: list[float]) -> dict:
    if len(positions) < 3:
        return {"known": False, "normalized": 0.0, "positions_per_period2": None}
    d_last, d_prev = positions[-1] - positions[-2], positions[-2] - positions[-3]
    acc = d_last - d_prev
    norm = max(0.0, min(1.0, acc / max(abs(d_prev), 1.0))) if d_last > 0 else 0.0
    return {"known": True, "normalized": round(norm, 3), "positions_per_period2": round(acc, 3)}


def forecast_page(page: PageIn, sc: Scenario) -> dict:
    h = page.history
    positions = [p.position for p in h]
    clicks = [p.clicks for p in h]
    last_pos, last_clicks = positions[-1], clicks[-1]
    n = len(h)
    c0_30 = last_clicks * 30 / page.period_days
    c0_daily = last_clicks / page.period_days

    fit = fit_erosion(positions, page.period_days)
    decaying = fit["status"] == "decaying" and last_clicks > 0
    model, rate = fit["model"], (fit["rate_per_day"] if decaying else 0.0)
    mult = sc.velocity_multiplier
    best_pos = min(positions)
    target = last_pos - sc.recovery_pct * (last_pos - best_pos) if best_pos < last_pos else last_pos
    lag, ramp = sc.refresh_lag_days, sc.ramp_days

    def base_pos(t: float, m: float = mult) -> float:
        return position_at(t, last_pos, model, rate, m)

    def refreshed_pos(t: float) -> float:
        if not decaying or t <= lag:
            return base_pos(t)
        start = base_pos(lag)
        if t >= lag + ramp:
            return min(start, target)
        return start + (min(start, target) - start) * (t - lag) / ramp

    ratio = lambda p: ctr(p) / ctr(last_pos)  # noqa: E731

    def clicks_30(posfn, t: float) -> float:
        return c0_30 * ratio(posfn(t))

    def point(day: int) -> dict:
        return {
            "day": day,
            "position": round(base_pos(day), 1),
            "baseline": round(clicks_30(base_pos, day), 1),
            "baseline_low": round(c0_30 * ratio(base_pos(day, mult * BAND_AGGRESSIVE)), 1),
            "baseline_high": round(c0_30 * ratio(base_pos(day, mult * BAND_CONSERVATIVE)), 1),
            "refreshed": round(clicks_30(refreshed_pos, day), 1),
            "refreshed_position": round(refreshed_pos(day), 1),
        }

    # cumulative click loss versus "stay at today's rate", integrated day by day
    loss_base, loss_ref = [], []
    cb = cr = 0.0
    for d in range(HORIZON):
        t = d + 0.5
        cb += c0_daily - c0_daily * ratio(base_pos(t))
        cr += c0_daily - c0_daily * ratio(refreshed_pos(t))
        loss_base.append(cb)
        loss_ref.append(cr)
    loss90, loss90_ref = loss_base[-1], loss_ref[-1]

    # --- Preventative Action Score
    if page.keyword_volume is not None:
        demand, demand_src = page.keyword_volume, "keyword_volume"
    elif h[-1].impressions is not None:
        demand, demand_src = h[-1].impressions * 30 / page.period_days, "impressions"
    else:
        demand, demand_src = c0_30 / ctr(last_pos), "estimated from clicks"
    acc = acceleration(positions)
    rel_loss = loss90 / (c0_daily * HORIZON) if c0_daily > 0 else 0.0
    s_loss = min(1.0, math.log10(1 + loss90) / math.log10(1 + LOSS_REF))
    s_vol = min(1.0, math.log10(1 + demand) / math.log10(1 + VOLUME_REF))
    s_decay = 0.6 * min(1.0, rel_loss / 0.6) + 0.4 * acc["normalized"]
    score = round(100 * (0.45 * s_loss + 0.25 * s_vol + 0.30 * s_decay)) if decaying else 0
    tier = "Act now" if score >= 70 else "Plan a refresh" if score >= 40 else "Monitor"

    # --- confidence + honest notes
    notes: list[str] = []
    level = 0 if n == 2 else 1 if n == 3 else 2
    if n == 2:
        notes.append("Only two periods: the trend is a straight line between them and acceleration cannot be measured. Add more periods for a sturdier model.")
    if last_clicks < MIN_CLICKS_FOR_CONFIDENCE:
        level = 0
        notes.append(f"Fewer than {MIN_CLICKS_FOR_CONFIDENCE} clicks in the latest period: percentage swings this small are mostly noise.")
    if n >= 3 and fit["r2"] < 0.6:
        level = max(0, level - 1)
        notes.append(f"The {model} trend fits the history poorly (R² {fit['r2']:.2f}).")
    if n >= 2 and clicks[-2] >= MIN_CLICKS_FOR_CONFIDENCE:
        implied = clicks[-2] * ctr(positions[-1]) / ctr(positions[-2])
        if clicks[-1] < 0.8 * implied:
            notes.append("Clicks fell faster than the position change alone explains (SERP features, lower demand or a CTR problem), so this forecast may be optimistic.")
    if decaying and base_pos(HORIZON) > 50:
        notes.append("At this pace the page falls past position 50 within 90 days, where it receives almost no clicks.")
    if not decaying:
        notes.append("Position is stable or improving, so no decay is projected." if fit["status"] != "decaying" else "No clicks to lose.")
    notes.append("Search demand is assumed constant over the next 90 days.")
    confidence = ("low", "medium", "high")[level]

    curve = [point(d) for d in range(0, HORIZON + 1, CURVE_STEP)]
    return {
        "url": page.url,
        "keyword": page.keyword,
        "status": "decaying" if decaying else ("stable" if fit["status"] == "decaying" else fit["status"]),  # decaying but no clicks left = stable
        "model": {
            "type": model,
            "periods": n,
            "r2": round(fit["r2"], 3),
            "positions_per_period": round(fit["per_period"], 2),
            "positions_per_30d": round(fit["per_period"] * 30 / page.period_days, 2),
            "acceleration": acc,
        },
        "current": {"clicks_30d": round(c0_30, 1), "position": round(last_pos, 1), "best_position": round(best_pos, 1)},
        "points": [p for p in curve if p["day"] in POINT_DAYS],
        "curve": curve,
        "losses": {
            "d30": round(loss_base[29], 1), "d60": round(loss_base[59], 1), "d90": round(loss90, 1),
            "d90_refreshed": round(loss90_ref, 1), "recoverable_90d": round(loss90 - loss90_ref, 1),
            "pct_of_current_90d": round(rel_loss * 100, 1),
        },
        "action_score": score,
        "tier": tier,
        "score_breakdown": {
            "loss_magnitude": {"weight": 0.45, "value": round(s_loss, 3)},
            "demand": {"weight": 0.25, "value": round(s_vol, 3), "monthly_demand": round(demand), "source": demand_src},
            "decay_speed_and_acceleration": {"weight": 0.30, "value": round(s_decay, 3), "acceleration_known": acc["known"]},
        },
        "confidence": confidence,
        "notes": notes,
        "assumptions": {
            "velocity_multiplier": mult, "recovery_pct": sc.recovery_pct, "refresh_lag_days": lag, "ramp_days": ramp,
            "refreshed_target_position": round(target, 1), "band": f"{BAND_CONSERVATIVE}x to {BAND_AGGRESSIVE}x the fitted velocity",
        },
    }


@router.post("/page-decay")
async def forecast_page_decay(data: PageDecayRequest):
    """Project 30/60/90-day clicks for one page: do nothing vs a content refresh."""
    page = PageIn(url=data.url, keyword=data.keyword, keyword_volume=data.keyword_volume, period_days=data.period_days, history=data.history)
    return {"status": "success", "forecast": forecast_page(page, Scenario(**data.model_dump(include=set(Scenario.model_fields))))}


def aggregate_forecasts(results: list[dict]) -> dict:
    """Totals and a combined curve over the DECAYING pages of a set of page forecasts (also used by the report exporter)."""
    decaying = [r for r in results if r["status"] == "decaying"]

    def agg(day_filter) -> list[dict]:
        out = []
        for i, d in enumerate(range(0, HORIZON + 1, CURVE_STEP)):
            if not day_filter(d):
                continue
            row = {"day": d}
            for k in ("baseline", "baseline_low", "baseline_high", "refreshed"):
                row[k] = round(sum(r["curve"][i][k] for r in decaying), 1)
            out.append(row)
        return out

    return {
        "totals": {
            "pages": len(results),
            "decaying": len(decaying),
            "clicks_now_30d": round(sum(r["current"]["clicks_30d"] for r in decaying), 1),
            "loss_30d": round(sum(r["losses"]["d30"] for r in decaying), 1),
            "loss_60d": round(sum(r["losses"]["d60"] for r in decaying), 1),
            "loss_90d": round(sum(r["losses"]["d90"] for r in decaying), 1),
            "loss_90d_refreshed": round(sum(r["losses"]["d90_refreshed"] for r in decaying), 1),
            "recoverable_90d": round(sum(r["losses"]["recoverable_90d"] for r in decaying), 1),
        },
        "points": agg(lambda d: d in POINT_DAYS),
        "curve": agg(lambda d: True),
    }


@router.post("/batch")
async def forecast_batch(data: BatchRequest):
    """Forecast many pages under one scenario, with totals and an aggregate curve for the decaying ones."""
    sc = Scenario(**data.model_dump(include=set(Scenario.model_fields)))
    results = [forecast_page(p, sc) for p in data.pages]
    results.sort(key=lambda r: (-r["losses"]["d90"], r["url"]))
    return {"status": "success", "scenario": sc.model_dump(), **aggregate_forecasts(results), "pages": results}
