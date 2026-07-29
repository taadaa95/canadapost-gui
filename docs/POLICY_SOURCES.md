# Policy sources and implementation decisions

Eligibility sources were retrieved 2026-07-26; Developer Portal sources were retrieved 2026-07-28. This file summarizes public Canada Post material; it does not reproduce the source text and is not legal advice. Rules are implemented in `config/policy-rules.json` and `config/holiday-calendar.json`. If the evidence, shipment date, service mapping, calendar, or published policy is outside verified coverage, the application returns manual review rather than guessing.

## Source register

### CP-TRACKING-OPENAPI-2026-07-28 — Current Tracking API contract

- Publisher: Canada Post Corporation
- Product page: https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/product/tracking/api/tracking-api-1.0.0
- Official OpenAPI download: https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/download/4687/document
- Retrieved: July 28, 2026
- Source metadata: OpenAPI 3.0.0; title `Tracking`; contract version `1.0.0`; portal catalog API generation `2.0.0`; 82,326 bytes; SHA-256 `189b373a4df79f0f45e27280de72950bf3e18792c59775e674807e67318d2e29`.
- Contract derived: production gateway/base route, OAuth token route and client-credentials security scheme, `merchant` scope, Tracking details path, JSON request/response schemas, archive flags and documented errors.
- Implementation decision: `tests/fixtures/tracking-api-1.0.0.contract.json` contains only a sanitized contract summary. Step 2 identifies its actual operation contract as 1.0.0 while explaining that it runs on the portal's 2.0.0 generation.

### CP-DEVELOPER-PORTAL-2026-07-28 — Current platform, authentication and release policy

- Publisher: Canada Post Corporation
- Locations: https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/api/overview/tracking, https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/authentication-guide, and https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/release-notes
- Retrieved: July 28, 2026
- Policy derived: current platform released April 30, 2026; REST/JSON and OAuth 2.0 replace the legacy XML/SOAP/Basic contract; the client-credentials request uses client ID/API Key, client secret/API Secret, `grant_type=client_credentials`, and `merchant` scope; access tokens have an `expires_in` lifetime.
- Implementation decision: current and legacy credentials are separate encrypted settings. Tokens are memory-only. There is no OAuth-to-Basic fallback.

### CP-API-RATE-LIMITS-2026-07-28 — Developer Portal rate-limit guidance

- Publisher: Canada Post Corporation
- Location: https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/rate-limits
- Retrieved: July 28, 2026
- Guidance derived: rolling 60-second windows, at least 250 ms between requests, and a 60-second wait after throttling; test limits can be lower.
- Ambiguity: the public page does not publish a numeric quota specific to Tracking details.
- Implementation decision: no undocumented quota is encoded. `Retry-After` is parsed safely, and systemic/bulk failures require deliberate operator retry.

### CP-GUIDE-2026-05-29 — Parcel Services Customer Guide

- Publisher: Canada Post Corporation
- Location: https://www.canadapost-postescanada.ca/cpc/doc/en/support/customer-guide/amalgamated-parcel-services-guide.pdf
- Source effective date: May 29, 2026
- Rules derived: a business day excludes Saturday, Sunday, statutory holidays, and days normally observed as holidays by Canada Post; the guarantee is measured from acceptance (first physical item-level scan) to the time delivery was first attempted; domestic peak-period claims require delivery at least two business days after the standard; delay claims must be initiated within 30 business days from the delivery-standard date; specified services, air-stage limitations, Return to Sender, customer non-compliance, special handling, events beyond Canada Post's control, and other exclusions apply.
- Ambiguities: customer-specific agreements and notices may alter or suspend the guarantee; many packaging, label, route, and cause facts cannot be inferred from tracking alone.
- Implementation decision: first attempt is a distinct mandatory evidence field populated by the earliest qualifying attempt event. Successful delivery is itself a delivery attempt, so the same documented event may populate both first-attempt and actual-delivery fields with an explicit shared-event provenance flag. Earlier failed attempts remain authoritative over later delivery or pickup. Observable confirmed exclusions can be `NOT_ELIGIBLE`; possible exclusions enter `MANUAL_REVIEW`.

### CP-GUIDE-2025-12-05 — Parcel Services Customer Guide

- Publisher: Canada Post Corporation
- Location: https://www.canadapost-postescanada.ca/cpc/doc/en/support/customer-guide/amalgamated-parcel-services-guide.pdf (the official search index identified the December 5, 2025 edition; Canada Post now serves the current edition at this location)
- Source effective date: December 5, 2025
- Rules derived: same first-attempt, business-day, peak-period, service, exclusion, and 30-business-day claim-window structure used by the current guide.
- Ambiguities: the stable URL now resolves to the newer guide, so this version is retained only for the bounded period supported by the official indexed metadata and the specific 2025 peak notice.
- Implementation decision: version boundary is explicit; uncertain differences require manual review.

### CP-LATE-PACKAGES-2026-07-26 — Claims: Late packages

- Publisher: Canada Post Corporation
- Location: https://www.canadapost-postescanada.ca/cpc/en/support/kb/claims/late-packages.page
- Retrieved: July 26, 2026
- Rules derived: only the sender may request a refund; listed guaranteed services are domestic Priority, Xpresspost, and Expedited Parcel, and outbound Priority Worldwide, Xpresspost USA, and Xpresspost International; the package must be delivered after its guaranteed time; the request window is 30 business days; customs delays are excluded for outbound shipments.
- Ambiguities: the support page is a summary and does not establish every contract or route-specific exception.
- Implementation decision: service table is versioned; unknown service codes and incomplete sender/claim data require manual review.

### CP-DELIVERY-STANDARDS-2026-07-26 — Delivery standards and On-Time Delivery Guarantee

- Publisher: Canada Post Corporation
- Locations: https://www.canadapost-postescanada.ca/cpc/en/support/articles/delivery-standards/overview.page and https://www.canadapost-postescanada.ca/cpc/en/support/articles/parcel-services-shipping-in-canada/on-time-delivery-guarantee.page
- Retrieved: July 26, 2026
- Rules derived: delivery standards use business days; returned/redirected items and multiple service/external-cause conditions are excluded; guarantees can be modified for peak periods or suspended for causes outside Canada Post's reasonable control.
- Ambiguities: public notices and shipment-specific evidence are required to determine many suspensions.
- Implementation decision: recognized signals for weather, labour, operational disruption, customs, standard adjustments, and possible suspension route to manual review unless a specific verified rule proves ineligibility.

### CP-HOLIDAYS-2025-2026 — Official holiday schedule

- Publisher: Canada Post Corporation
- Location: https://www.canadapost-postescanada.ca/cpc/en/support/kb/other-products-services/post-office/find-out-operating-hours-on-holidays.page
- Published coverage: 2025 and 2026; the predecessor official schedule supplied 2024 dates at https://www.canadapost-postescanada.ca/holidays
- Rules derived: no regular collection or delivery occurs on the listed national, provincial, territorial, and observed holidays; explicit calendar dates are stored rather than calculated.
- Ambiguities: provincial holidays require the applicable province/territory; Canada Post says a weekend holiday may be observed on the next business day, so only explicitly published observed dates are used.
- Implementation decision: the calendar covers 2024–2026. Regional-holiday intervals without a route province and all dates outside coverage enter manual review.

### CP-PEAK-2025 — Modifications to delivery guarantees during peak season

- Publisher: Canada Post Corporation
- Location: https://www.canadapost-postescanada.ca/cpc/doc/en/business/customer-peak-season-notice-e-2025.pdf
- Posted: September 3, 2025; effective for items mailed November 3, 2025 through January 11, 2026
- Rule derived: eligible domestic Priority, Xpresspost, and Expedited Parcel shipments had to be at least two business days late during the stated period.
- Ambiguities: the notice addresses mailed dates and domestic services only.
- Implementation decision: the peak threshold is a data row keyed by shipment date and service, not hard-coded control flow. Other services do not inherit it.

### CP-GUARANTEE-RESUMED-2025-01-06 — Domestic guarantees reinstated

- Publisher: Canada Post Corporation
- Location: https://www.canadapost-postescanada.ca/cpc/en/our-company/news-and-media/corporate-news/negotiations/2025-01-07-canada-post-back-to-full-service-levels-for-domestic-parcels
- Published: January 7, 2025; effective for items inducted January 6, 2025
- Rule derived: domestic on-time guarantees resumed for items inducted on or after January 6, 2025, with the then-current peak modification through January 12, 2025.
- Ambiguities: this source does not define the full preceding suspension interval.
- Implementation decision: automatic policy coverage begins January 6, 2025. Earlier shipments are manual review rather than assumed eligible or ineligible.

## Manual-review fallback

Manual review is mandatory for missing first-attempt evidence, conflicting events, unknown services/events, regional-holiday ambiguity, policy/calendar dates outside coverage, possible suspension or exclusion signals, and incomplete claim data. A human resolution is stored separately and never replaces the immutable automated classification.
> Operational-model update (2026-07-29): this document is retained as historical research and provenance only. The application no longer attempts to reproduce these complete policy rules. Step 2 identifies a delivered `LATE_CANDIDATE` when authoritative tracking shows successful delivery after the original/public Delivery Standard. First attempt is informational and revised estimates do not suppress that result. Canada Post makes the final eligibility decision.
