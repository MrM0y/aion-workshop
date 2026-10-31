# Supply observations

- Capture only reads the window selected by the user. It does not open game menus.
- Detail recognition requires a supply heading, an unambiguous catalog item, explicit quantity and one remaining-time value. Multiple alternatives or deadlines are rejected, rather than counted as independent requests.
- A recognized request is character-scoped evidence. It does not establish that every player received that request, or that the observed moment was its start.
- Observations persist beside the selected instance's state file. Samples do not write observations. Request frames do not write market prices.
- Repeated observations preserve the first observation and cannot extend the deadline. Expired cards disappear, but history remains.
- Item and direct-ingredient charts receive the same observation ID. Financial cards reuse current craft calculations; the requested quantity is not a recommendation to produce that many units.
- Historical response compares median asking-price lows in six-hour windows before and after observation. It requires five nonoverlapping comparable requests, matching target and quantity, with coverage in both windows. It describes an association, not a causal effect, transaction price, demand forecast or sale probability.

## Verification and limits

Parser, persistence, HTTP collection-to-chart flow, cards, expiry and historical statistics have automated fixture tests. Windows OCR was also exercised through the running local HTTP endpoint on generated English and Russian control images (2026-10-31); both recognized the correct item, quantity and deadline, with sample mode leaving the supply store unchanged. No actual supply-window screenshot was available for validating the Windows OCR/layout end to end. Unknown group titles and ambiguous overview screens require opening request details. No live server-wide request feed or external request catalog was integrated.

Accurate sale-time and price optimization still require timestamped confirmed sales at relevant prices, competition and quantity observations. Rolling 28-day totals and disappearing listings cannot substitute for those records.
