import type { Intent } from "../ContentBriefPanel";

const TRANSACTIONAL = /\b(buy|purchase|order|quote|free trial|demo|sign ?up|get started|discount|coupon)\b/i;
const COMMERCIAL = /\b(best|top|vs|versus|compare|comparison|alternatives?|software|platforms?|tools?|services?|vendors?|providers?|pricing)\b/i;

/** A quick guess at search intent from the wording of a keyword. The brief panel lets the user change it. */
export function inferIntent(keyword: string): Intent {
  if (TRANSACTIONAL.test(keyword)) return "Transactional";
  if (COMMERCIAL.test(keyword)) return "Commercial";
  return "Informational";
}
