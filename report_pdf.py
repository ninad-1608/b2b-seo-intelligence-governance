"""
ReportLab renderer for the executive audit. render_pdf(report) -> (pdf bytes, page count).

Rules this file keeps:
  * Every string that did not come from this file goes through esc(): Paragraph parses markup, and the built-in Helvetica only has the
    Windows-1252 characters, so anything else becomes "?" instead of crashing or drawing as a box.
  * The disclaimer is drawn in the footer of EVERY page, the cover included.
  * Demo figures are marked on every page (header tag and a faint diagonal watermark), so they cannot pass for real results.
"""

import datetime
import io
import re
from xml.sax.saxutils import escape

from reportlab.graphics.shapes import Circle, Drawing, Line, PolyLine, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import BaseDocTemplate, Frame, KeepTogether, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

DISCLAIMER = "Scores and projections are ranking aids to prioritize investigation and risk. They do not predict traffic, leads, or revenue."

INDIGO, INDIGO_DARK = colors.HexColor("#4f46e5"), colors.HexColor("#312e81")
INK, MUTED, FAINT = colors.HexColor("#0f172a"), colors.HexColor("#475569"), colors.HexColor("#94a3b8")
RULE, PANEL, ZEBRA = colors.HexColor("#e2e8f0"), colors.HexColor("#f8fafc"), colors.HexColor("#f1f5f9")
RED, AMBER, GREEN = colors.HexColor("#e11d48"), colors.HexColor("#d97706"), colors.HexColor("#059669")
SEVERITY_COLOR = {"critical": RED, "warning": AMBER, "action": INDIGO, "error": RED, "info": MUTED}
SEVERITY_LABEL = {"critical": "Critical", "warning": "Warning", "action": "Action needed", "error": "Error", "info": "Note"}

PAGE_W, PAGE_H = A4
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 18 * mm, 22 * mm, 24 * mm
CONTENT_W = PAGE_W - 2 * MARGIN_X

_REPL = {"→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "ok", "−": "-", " ": " ", "​": "", "…": "..."}
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def safe(s) -> str:
    """Plain text the built-in font can draw."""
    s = _CTRL.sub(" ", str(s if s is not None else ""))
    for k, v in _REPL.items():
        s = s.replace(k, v)
    return s.encode("cp1252", "replace").decode("cp1252")


def esc(s) -> str:
    """Safe AND markup-escaped: for any text placed inside a Paragraph."""
    return escape(safe(s))


def clip(s, n: int) -> str:
    s = " ".join(safe(s).split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "..."


def num(v, digits: int = 0) -> str:
    return f"{v:,.{digits}f}"


def pretty_ts(iso: str | None) -> str:
    if not iso:
        return "n/a"
    try:
        d = datetime.datetime.fromisoformat(iso)
    except ValueError:
        return safe(iso)
    return d.strftime("%d %b %Y, %H:%M") + (" UTC" if d.tzinfo else "")


# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------
def _style(name, **kw) -> ParagraphStyle:
    base = dict(fontName="Helvetica", fontSize=9.2, leading=13, textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    "body": _style("body"),
    "small": _style("small", fontSize=8, leading=11, textColor=MUTED),
    "tiny": _style("tiny", fontSize=7.2, leading=9.5, textColor=MUTED),
    "h1": _style("h1", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=INDIGO_DARK, spaceAfter=2),
    "h2": _style("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=INK, spaceBefore=10, spaceAfter=3),
    "lead": _style("lead", fontSize=10, leading=14.5, textColor=MUTED),
    "cell": _style("cell", fontSize=8.2, leading=10.6),
    "cellb": _style("cellb", fontName="Helvetica-Bold", fontSize=8.2, leading=10.6),
    "cellm": _style("cellm", fontSize=7.6, leading=10, textColor=MUTED),
    "th": _style("th", fontName="Helvetica-Bold", fontSize=7.6, leading=10, textColor=colors.white),
    "kpi_v": _style("kpi_v", fontName="Helvetica-Bold", fontSize=20, leading=23, textColor=INDIGO_DARK),
    "kpi_l": _style("kpi_l", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=INK),
    "kpi_h": _style("kpi_h", fontSize=7.2, leading=9, textColor=MUTED),
    "note": _style("note", fontSize=9, leading=13, textColor=INK),
}


def P(text, style="body") -> Paragraph:
    return Paragraph(text, ST[style])


def heading(title: str, blurb: str = "") -> list:
    out = [P(esc(title), "h1")]
    t = Table([[""]], colWidths=[CONTENT_W], rowHeights=[1.6])
    t.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 1.4, INDIGO)]))
    out.append(t)
    if blurb:
        out += [Spacer(1, 3), P(esc(blurb), "small")]
    out.append(Spacer(1, 6))
    return out


def grid(rows: list[list], widths: list[float], repeat: int = 1, align_right: tuple[int, ...] = ()) -> Table:
    """A table with a coloured header row and zebra body. `rows[0]` is the header (plain strings); body cells are Paragraphs or strings."""
    head = [P(esc(h), "th") for h in rows[0]]
    body = [[c if not isinstance(c, str) else P(esc(c), "cell") for c in r] for r in rows[1:]]
    t = Table([head] + body, colWidths=widths, repeatRows=repeat)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), INDIGO_DARK), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, RULE), ("BOX", (0, 0), (-1, -1), 0.4, RULE),
    ]
    for i in range(1, len(rows)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(style))
    return t


def chip(text: str, color) -> Table:
    t = Table([[Paragraph(f'<font color="white"><b>{esc(text)}</b></font>', _style("chip", fontSize=7, leading=9, alignment=1))]], colWidths=[None])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), color), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]))
    return t


def callout(text_html: str, color=INDIGO, width: float = CONTENT_W) -> Table:
    t = Table([[Paragraph(text_html, ST["note"])]], colWidths=[width])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PANEL), ("LINEBEFORE", (0, 0), (0, -1), 3, color), ("BOX", (0, 0), (-1, -1), 0.4, RULE),
                           ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10)]))
    return t


# ---------------------------------------------------------------------------
# Page furniture: header, footer disclaimer, watermark, "Page x of y"
# ---------------------------------------------------------------------------
class ReportCanvas(canvas.Canvas):
    meta: dict = {}

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._pages: list[dict] = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for number, state in enumerate(self._pages, start=1):
            self.__dict__.update(state)
            self.furniture(number, total)
            super().showPage()
        super().save()

    def furniture(self, number: int, total: int) -> None:
        meta = self.meta
        demo = meta.get("data_source") == "sample"
        self.saveState()
        if demo:  # faint diagonal watermark behind everything
            self.setFont("Helvetica-Bold", 78)
            self.setFillColor(colors.Color(0.86, 0.15, 0.3, alpha=0.07))
            self.translate(PAGE_W / 2, PAGE_H / 2)
            self.rotate(35)
            self.drawCentredString(0, 0, "DEMO DATA")
        self.restoreState()

        self.saveState()
        if number > 1:  # header on every page after the cover
            self.setFont("Helvetica-Bold", 7.8)
            self.setFillColor(INDIGO_DARK)
            self.drawString(MARGIN_X, PAGE_H - 13 * mm, safe(meta["title"]).upper())
            self.setFont("Helvetica", 7.8)
            self.setFillColor(MUTED)
            self.drawString(MARGIN_X + 118, PAGE_H - 13 * mm, clip(f"{meta['prepared_for']}   |   {meta['date_display']}", 70))
            if demo:
                self.setFillColor(RED)
                self.setFont("Helvetica-Bold", 7.8)
                self.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 13 * mm, "DEMO DATA - NOT YOUR RESULTS")
            self.setStrokeColor(RULE)
            self.setLineWidth(0.6)
            self.line(MARGIN_X, PAGE_H - 15.5 * mm, PAGE_W - MARGIN_X, PAGE_H - 15.5 * mm)
        # footer: the disclaimer, then the page number
        self.setStrokeColor(RULE)
        self.setLineWidth(0.6)
        self.line(MARGIN_X, 19 * mm, PAGE_W - MARGIN_X, 19 * mm)
        p = Paragraph(esc(DISCLAIMER), _style("foot", fontSize=7.6, leading=10, textColor=MUTED))
        w, h = p.wrap(CONTENT_W - 28 * mm, 14 * mm)
        p.drawOn(self, MARGIN_X, 17 * mm - h)
        self.setFont("Helvetica", 7.8)
        self.setFillColor(MUTED)
        self.drawRightString(PAGE_W - MARGIN_X, 14.2 * mm, f"Page {number} of {total}")
        self.restoreState()


def cover_art(canv, doc) -> None:
    meta = doc.report_meta
    canv.saveState()
    canv.setFillColor(INDIGO_DARK)
    canv.rect(0, PAGE_H - 112 * mm, PAGE_W, 112 * mm, stroke=0, fill=1)
    canv.setFillColor(INDIGO)
    canv.rect(0, PAGE_H - 112 * mm, 9 * mm, 112 * mm, stroke=0, fill=1)
    canv.setFillColor(colors.HexColor("#c7d2fe"))
    canv.setFont("Helvetica-Bold", 9)
    canv.drawString(MARGIN_X + 6 * mm, PAGE_H - 30 * mm, "CONFIDENTIAL  |  PREPARED FOR LEADERSHIP REVIEW")
    canv.setFillColor(colors.white)
    canv.setFont("Helvetica-Bold", 36)
    canv.drawString(MARGIN_X + 6 * mm, PAGE_H - 56 * mm, "SEO Executive")
    canv.drawString(MARGIN_X + 6 * mm, PAGE_H - 70 * mm, "Audit")
    canv.setFont("Helvetica", 12.5)
    canv.setFillColor(colors.HexColor("#c7d2fe"))
    canv.drawString(MARGIN_X + 6 * mm, PAGE_H - 84 * mm, "Priorities, risks and what needs a decision")
    canv.setFont("Helvetica-Bold", 14)
    canv.setFillColor(colors.white)
    canv.drawString(MARGIN_X + 6 * mm, PAGE_H - 100 * mm, clip(f"Prepared for {meta['prepared_for']}", 62))
    canv.restoreState()


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------
def nice_max(v: float) -> float:
    if v <= 0:
        return 10
    mag = 10 ** (len(str(int(v))) - 1)
    for m in (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if m * mag >= v:
            return m * mag
    return 10 * mag


def forecast_chart(curve: list[dict], width: float, height: float = 170) -> Drawing:
    """Clicks per 30 days over the next 90 days: do-nothing line, its low-to-high range band, and the refresh scenario."""
    d = Drawing(width, height)
    left, right, top, bottom = 44, 12, 12, 26
    pw, ph = width - left - right, height - top - bottom
    ymax = nice_max(max(max(p["baseline_high"], p["refreshed"], p["baseline"]) for p in curve))
    X = lambda day: left + day / 90 * pw  # noqa: E731
    Y = lambda v: bottom + v / ymax * ph  # noqa: E731
    d.add(Rect(left, bottom, pw, ph, strokeColor=RULE, strokeWidth=0.5, fillColor=colors.white))
    for f in (0, 0.25, 0.5, 0.75, 1):
        y = Y(ymax * f)
        d.add(Line(left, y, left + pw, y, strokeColor=ZEBRA if f not in (0, 1) else RULE, strokeWidth=0.5))
        d.add(String(left - 5, y - 2.5, num(ymax * f), fontName="Helvetica", fontSize=6.8, fillColor=MUTED, textAnchor="end"))
    for day in (0, 30, 60, 90):
        d.add(String(X(day), bottom - 12, "Today" if day == 0 else f"Day {day}", fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))
        d.add(Line(X(day), bottom, X(day), bottom - 3, strokeColor=FAINT, strokeWidth=0.5))
    band = [(X(p["day"]), Y(p["baseline_high"])) for p in curve] + [(X(p["day"]), Y(p["baseline_low"])) for p in reversed(curve)]
    poly = Polygon([c for pt in band for c in pt], fillColor=colors.Color(0.88, 0.11, 0.28, alpha=0.16), strokeColor=colors.Color(0.88, 0.11, 0.28, alpha=0.45), strokeWidth=0.6)
    poly.strokeDashArray = [2, 2]
    d.add(poly)
    now_y = Y(curve[0]["baseline"])
    now_line = Line(left, now_y, left + pw, now_y, strokeColor=FAINT, strokeWidth=0.7)
    now_line.strokeDashArray = [3, 3]
    d.add(now_line)
    d.add(PolyLine([c for p in curve for c in (X(p["day"]), Y(p["baseline"]))], strokeColor=RED, strokeWidth=1.8))
    d.add(PolyLine([c for p in curve for c in (X(p["day"]), Y(p["refreshed"]))], strokeColor=GREEN, strokeWidth=1.8))
    for p in curve:
        if p["day"] in (0, 30, 60, 90):
            d.add(Circle(X(p["day"]), Y(p["baseline"]), 2.4, fillColor=colors.white, strokeColor=RED, strokeWidth=1.2))
            d.add(Circle(X(p["day"]), Y(p["refreshed"]), 2.4, fillColor=colors.white, strokeColor=GREEN, strokeWidth=1.2))
    last = curve[-1]
    d.add(String(left + pw - 4, Y(last["baseline_high"]) + 4, f"High case {num(last['baseline_high'])}", fontName="Helvetica-Bold", fontSize=6.8, fillColor=RED, textAnchor="end"))
    d.add(String(left + pw - 4, Y(last["baseline_low"]) - 9, f"Low case {num(last['baseline_low'])}", fontName="Helvetica-Bold", fontSize=6.8, fillColor=RED, textAnchor="end"))
    return d


def legend() -> Table:
    def swatch(color, dashed=False, band=False):
        dr = Drawing(16, 9)
        if band:
            dr.add(Rect(0, 1, 16, 7, fillColor=colors.Color(0.88, 0.11, 0.28, alpha=0.2), strokeColor=colors.Color(0.88, 0.11, 0.28, alpha=0.5), strokeWidth=0.5))
        else:
            ln = Line(0, 4.5, 16, 4.5, strokeColor=color, strokeWidth=1.8)
            if dashed:
                ln.strokeDashArray = [3, 3]
            dr.add(ln)
        return dr

    cells = [swatch(RED), P("Do nothing", "tiny"), swatch(None, band=True), P("Range: low to high case", "tiny"), swatch(GREEN), P("With content refresh (scenario)", "tiny"),
             swatch(FAINT, dashed=True), P("Today's level", "tiny")]
    t = Table([cells], colWidths=[18, 52, 18, 100, 18, 118, 18, 60])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 1), ("RIGHTPADDING", (0, 0), (-1, -1), 1)]))
    return t


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------
def build_cover(r: dict) -> list:
    m = r["meta"]
    story: list = [Spacer(1, 112 * mm - MARGIN_TOP + 8 * mm)]
    demo = m["data_source"] == "sample"
    badge_color = RED if demo else GREEN
    story.append(callout(f'<b><font color="{badge_color.hexval().replace("0x", "#")}">{"DEMO DATA" if demo else "LIVE DATA"}</font></b><br/>{esc(m["data_source_label"])}', badge_color))
    story.append(Spacer(1, 10))
    rows = [["Prepared for", m["prepared_for"]], ["Prepared by", m["prepared_by"] or "-"], ["Date", f"{m['date_display']}, {m['time_display']}"]]
    t = Table([[P(f"<b>{esc(a)}</b>", "small"), P(esc(b), "body")] for a, b in rows], colWidths=[28 * mm, CONTENT_W - 28 * mm])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(t)
    story.append(Spacer(1, 12))
    story.append(P("<b>Inside this report</b>", "body"))
    contents = ["Executive summary and what needs attention now", "Business priorities and 30/60/90-day scenarios, with their ranges", "Technical audit: cannibalization, data freshness"]
    if m["include_governance"]:
        contents.append("Governance: who signed off what, and when")
    story += [Spacer(1, 3)] + [P(f"&bull; {esc(c)}", "small") for c in contents]
    story.append(PageBreak())
    return story


def build_summary(r: dict) -> list:
    m, tri = r["meta"], r["triage"]
    story = heading("Executive summary", "The state of search performance and decisions at a glance.")
    k = r["kpis"]
    cells = [[[P(esc(x["value"]), "kpi_v"), P(esc(x["label"]), "kpi_l"), P(esc(x["hint"]), "kpi_h")] for x in k[i:i + 3]] for i in (0, 3)]
    tiles = Table(cells, colWidths=[CONTENT_W / 3] * 3)
    tiles.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.4, RULE), ("INNERGRID", (0, 0), (-1, -1), 0.4, RULE), ("BACKGROUND", (0, 0), (-1, -1), PANEL), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8), ("LEFTPADDING", (0, 0), (-1, -1), 10)]))
    story += [tiles, Spacer(1, 8)]
    if m["notes"]:
        story += [P("Notes from the preparer", "h2"), callout(esc(m["notes"]), INDIGO), Spacer(1, 4)]
    story.append(P("Needs your attention", "h2"))
    if tri["items"]:
        rows = [["Level", "What", "Detail"]]
        for it in tri["items"]:
            rows.append([chip(it["severity_label"], SEVERITY_COLOR[it["severity"]]), P(f"<b>{esc(it['title'])}</b>", "cell"), it["summary"]])
        story.append(grid(rows, [24 * mm, 48 * mm, CONTENT_W - 72 * mm]))
        if tri["hidden"]:
            story.append(P(f"{tri['hidden']} further item(s) are not shown; the dashboard lists the five most urgent.", "tiny"))
    elif tri["status"] == "degraded":
        story.append(callout("Some checks could not run, so this list may be incomplete.", AMBER))
    else:
        story.append(callout(f"<b>{esc(tri['message'])}.</b> No stale evidence, refused crawlers, unreviewed high-priority items or harmful overlaps need a decision right now.", GREEN))
    pri = r["priorities"]
    story += [P("Where the opportunities stand", "h2")]
    order = ["Proposed", "Approved", "Needs changes", "Rejected", "Measuring", "Completed"]
    sc = pri["status_counts"]
    story.append(P(" &nbsp;|&nbsp; ".join(f"<b>{sc[s]}</b> {esc(s)}" for s in order if sc.get(s)) or "No review decisions recorded yet.", "body"))
    return story


def build_priorities(r: dict) -> list:
    pri = r["priorities"]
    story = heading("Business priorities", f"Ranked by the four-factor opportunity score; {pri['threshold']:g} and above is high priority. Review status shows who has signed off.")
    rows = [["#", "Priority / keyword", "Score", "Level", "Review status", "Impressions"]]
    for i, p in enumerate(pri["rows"], start=1):
        status = p["status"] + (f" ({clip(p['reviewer'], 22)})" if p.get("reviewer") and p["status"] != "Proposed" else "")
        rows.append([str(i), P(f"<b>{esc(clip(p['priority'], 60))}</b><br/><font color='#475569'>{esc(clip(p['keyword'], 60))}</font>" + (" <font color='#4f46e5'>(custom)</font>" if p["custom"] else ""), "cell"),
                     f"{p['score']:.0f}", "High" if p["high_priority"] else "Standard", status, num(p["impressions"])])
    story.append(grid(rows, [8 * mm, 66 * mm, 14 * mm, 20 * mm, 40 * mm, CONTENT_W - 148 * mm]))
    story.append(P(f"Showing the top {len(pri['rows'])} of {pri['total']}. Impressions are built-in sample figures or numbers typed into the dashboard, not Search Console data. "
                   "Scores come from reviewer-set ratings, so they order what to look at first.", "tiny"))
    return story


def build_forecast(r: dict) -> list:
    f = r["forecast"]
    story = [Spacer(1, 14)] + heading("30 / 60 / 90-day scenarios", "What the recent ranking trend implies for pages that are losing ground, with and without a content refresh.")
    if not f["available"]:
        return story + [callout(f"<b>No projection in this report.</b> {esc(f['reason'])}", AMBER)]
    t, pts, a = f["totals"], f["points"], f["assumptions"]
    story.append(callout(
        f"<b>{num(t['loss_90d'])} clicks</b> could be lost over the next 90 days across <b>{t['decaying']}</b> decaying page(s) that earn <b>{num(t['clicks_now_30d'])}</b> clicks a month today. "
        f"Versus doing nothing, the content-refresh scenario finishes about <b>{num(t['recoverable_90d'])}</b> clicks ahead over the same 90 days"
        + (", more than the amount at risk, because it also wins back ground already lost" if t["recoverable_90d"] > t["loss_90d"] else "") + " (a scenario, not a promise).", INDIGO))
    story += [Spacer(1, 6), P("Clicks per 30 days, next 90 days", "h2"), forecast_chart(f["curve"], CONTENT_W), legend(), Spacer(1, 5)]
    by_day = {p["day"]: p for p in pts}
    loss = {30: t["loss_30d"], 60: t["loss_60d"], 90: t["loss_90d"]}
    rows = [["Horizon", "Do nothing (clicks / 30 days)", "Range: low to high case", "With refresh (scenario)", "Cumulative clicks at risk"]]
    for day in (0, 30, 60, 90):
        p = by_day.get(day)
        if not p:
            continue
        rows.append(["Today" if day == 0 else f"Day {day}", num(p["baseline"]), f"{num(p['baseline_low'])} - {num(p['baseline_high'])}", num(p["refreshed"]), "-" if day == 0 else num(loss[day])])
    story.append(KeepTogether([grid(rows, [24 * mm, 40 * mm, 42 * mm, 36 * mm, CONTENT_W - 142 * mm])]))
    story.append(Spacer(1, 3))
    story.append(P(f"<b>How to read the range.</b> The band runs from {esc(a['band'])}: a slower and a faster decay than the trend fitted to your data. Real results can fall outside it. "
                   f"The refresh line assumes a refresh goes live in {a['refresh_lag_days']} days and wins back {a['recovery_pct']:.0%} of the lost ground over {a['ramp_days']} days, so it has no range of its own; treat it as an upper bound. "
                   "Search demand is assumed constant, and seasonality, SERP features and algorithm updates are not modelled.", "tiny"))
    if f["pages"]:
        story.append(P("Pages driving the risk", "h2"))
        rows = [["Page", "Position now -> day 90", "Clicks / 30d", "90-day loss", "Priority", "Confidence"]]
        for p in f["pages"]:
            rows.append([P(f"<b>{esc(clip(p['url'], 52))}</b><br/><font color='#475569'>{esc(clip(p['keyword'], 40))}</font>", "cell"),
                         f"{p['position_now']:.1f} -> {p['position_day90']:.1f}", num(p["clicks_30d"]), num(p["loss_90d"]), p["tier"], p["confidence"].capitalize()])
        story.append(grid(rows, [54 * mm, 30 * mm, 19 * mm, 19 * mm, 25 * mm, CONTENT_W - 147 * mm]))
        extra = f["decaying_total"] - len(f["pages"])
        note = (f"{extra} more decaying page(s) are included in the totals. " if extra > 0 else "") + (f"{f['low_confidence']} projection(s) have low confidence (little history or a poor fit). " if f["low_confidence"] else "")
        if f["gone"]:
            note += f"{len(f['gone'])} page(s) lost every impression and are not projected."
        if note:
            story.append(P(esc(note.strip()), "tiny"))
    return story


def build_technical(r: dict) -> list:
    c, fr = r["cannibalization"], r["freshness"]
    story = heading("Technical audit", "Where search traffic is split between your own pages, and how current the evidence behind this report is.")
    counts = c["counts"]
    story.append(P("Cannibalization", "h2"))
    story.append(P(f"<b>{c['candidates']}</b> quer{'y' if c['candidates'] == 1 else 'ies'} showed two or more of your URLs. Each ran six checks (volume floor, canonical, regional and audience variants, "
                   f"country and same-day overlap, page type and intent, SERP domination): <b>{counts['harmful']}</b> harmful overlap(s), <b>{counts['false_positive']}</b> false positive(s), "
                   f"<b>{counts['cleared']}</b> cleared.", "body"))
    story.append(Spacer(1, 4))
    if c["harmful"]:
        rows = [["Query", "Impressions", "Risk", "Competing pages (best position first)"]]
        for h in c["harmful"]:
            urls = "<br/>".join(f"{esc(clip(u['url'], 58))} <font color='#475569'>({num(u['impressions'])} impr., pos {u['position']:.1f})</font>" for u in h["urls"][:4])
            rows.append([P(f"<b>{esc(clip(h['query'], 48))}</b>", "cell"), num(h["total_impressions"]), h["risk"], P(urls, "cell")])
        story.append(grid(rows, [46 * mm, 22 * mm, 16 * mm, CONTENT_W - 84 * mm]))
        partial = sum(1 for h in c["harmful"] if h["confidence"] == "partial")
        more = c["harmful_total"] - len(c["harmful"])
        story.append(P((f"{more} more not shown. " if more > 0 else "") + (f"{partial} finding(s) rest on only some of the six checks: the canonical and country/day checks need a deep check in the dashboard. " if partial else "")
                       + "Consolidating means keeping the strongest page and redirecting or canonicalising the rest.", "tiny"))
    else:
        story.append(callout("<b>No harmful overlaps.</b> Every query that looked like a split was cleared or ruled out by the validation checks.", GREEN))

    story += [P("Data freshness", "h2")]
    rows = [["Source", "Status", "Last synced", "Note"]]
    for s in fr["sources"]:
        col = {"current": GREEN, "stale": AMBER, "missing": MUTED}[s["status"]]
        rows.append([P(f"<b>{esc(s['label'])}</b>", "cell"), chip(s["status"].capitalize(), col), pretty_ts(s["last_sync"]) if s["last_sync"] else "-", s["detail"]])
    story.append(grid(rows, [38 * mm, 22 * mm, 36 * mm, CONTENT_W - 96 * mm]))
    story.append(Spacer(1, 4))
    cn = fr["counts"]
    story.append(P(f"Evidence audit run {esc(pretty_ts(fr['ran_at']))}: <b>{cn['error']}</b> error(s), <b>{cn['warning']}</b> warning(s), <b>{cn['info']}</b> note(s). "
                   "It checks data older than seven days, alert text that no longer matches the data, and missing positions or queries.", "small"))
    if fr["findings"]:
        rows = [["Level", "Finding"]]
        for f in fr["findings"]:
            rows.append([chip(SEVERITY_LABEL[f["severity"]], SEVERITY_COLOR[f["severity"]]), P(f"<b>{esc(clip(f['title'], 90))}</b><br/>{esc(clip(f['detail'], 220))}", "cell")])
        story += [Spacer(1, 3), grid(rows, [22 * mm, CONTENT_W - 22 * mm])]
        if fr["hidden_findings"]:
            story.append(P(f"{fr['hidden_findings']} more finding(s) are in the dashboard's Evidence Audit.", "tiny"))
    return story


EVENT_LABEL = {"decision": "Review decision", "baseline_locked": "Baseline locked", "completed": "Marked completed", "reset": "Reset after edit", "deleted": "Priority deleted"}


def build_governance(r: dict) -> list:
    g = r["governance"]
    story = heading("Governance and sign-off", "AI drafts, humans decide: every review decision, baseline lock and status change is written to an append-only log.")
    ch = g["chain"]
    if ch["ok"]:
        story.append(callout(f"<b>Decision log verified.</b> {ch['entries']} entr{'y' if ch['entries'] == 1 else 'ies'}, hash chain intact: no recorded decision has been edited or removed from the middle of the log.", GREEN))
    else:
        story.append(callout(f"<b>The decision log failed verification</b> at entry {ch['first_bad_id']}. Treat the history below as unreliable until it is investigated.", RED))
    story.append(Spacer(1, 6))
    if not g["entries"]:
        story.append(P("No review decisions have been recorded yet. Items marked 'Proposed' have not been looked at by a person.", "body"))
    else:
        rows = [["When", "Opportunity", "Event", "Reviewer", "Outcome", "Comment"]]
        for e in g["entries"]:
            outcome = e["verdict"] or (f"{e['from_status']} -> {e['to_status']}" if e["to_status"] else "-")
            rows.append([pretty_ts(e["when"]), P(f"<b>{esc(clip(e['opportunity'], 38))}</b>", "cell"), EVENT_LABEL.get(e["event"], e["event"]), clip(e["actor"], 22), outcome, P(esc(clip(e["comment"], 150)), "cellm")])
        story.append(grid(rows, [27 * mm, 34 * mm, 24 * mm, 24 * mm, 22 * mm, CONTENT_W - 131 * mm]))
        story.append(P(f"Most recent {g['shown']} of {g['log_total']} logged entries." if g["log_total"] > g["shown"] else f"All {g['log_total']} logged entries.", "tiny"))
    story.append(Spacer(1, 4))
    story.append(P("Reviewer names are typed in by the person deciding: the dashboard has no user accounts, so the log records who said they decided, not a verified identity.", "tiny"))
    return story


def build_about(r: dict) -> list:
    m = r["meta"]
    src = ("This report was built from the built-in demonstration figures, because no Search Console data has been synced. Replace it with a report from synced data before sharing it as results."
           if m["data_source"] == "sample" else "Search Console figures come from the synced data named on the cover. Business priorities use reviewer-set ratings and sample or typed-in impressions.")
    return [Spacer(1, 10), KeepTogether([P("About this report", "h2"), callout(f"<b>{esc(DISCLAIMER)}</b><br/><br/>{esc(src)}", INDIGO)])]


def render_pdf(report: dict) -> tuple[bytes, int]:
    buf = io.BytesIO()
    meta = report["meta"]

    class Canvas(ReportCanvas):
        pass

    Canvas.meta = meta
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=MARGIN_X, rightMargin=MARGIN_X, topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
                          title=f"{meta['title']} - {safe(meta['prepared_for'])}", author=safe(meta["prepared_by"] or "SEO Dashboard"), subject="Executive SEO audit", creator="SEO Dashboard")
    doc.report_meta = meta
    body = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W, PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    cover = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W, PAGE_H - MARGIN_BOTTOM - 20 * mm, id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="cover", frames=[cover], onPage=cover_art, autoNextPageTemplate="body"), PageTemplate(id="body", frames=[body])])

    story: list = build_cover(report) + build_summary(report) + [PageBreak()] + build_priorities(report) + build_forecast(report) + [PageBreak()] + build_technical(report)
    if report["governance"] is not None:
        story += [PageBreak()] + build_governance(report)
    story += build_about(report)
    doc.build(story, canvasmaker=Canvas)
    data = buf.getvalue()
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    return data, pages
