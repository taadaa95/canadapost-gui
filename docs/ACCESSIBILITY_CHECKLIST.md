# Accessibility validation checklist

Automated checks cover named buttons, labels, duplicate IDs, document language/title, a main landmark, visible keyboard focus, reduced-motion CSS and locale-key completeness. A release tester must still validate on Windows, Linux, and macOS:

- complete keyboard-only workflow and logical focus order;
- focus trap and Escape behavior for every modal;
- NVDA or equivalent labels, table navigation, live status and error announcements;
- 200% text zoom and high display scaling without clipping;
- contrast in every theme and forced/high-contrast modes;
- reduced motion, CAPTCHA pause/resume and browser-panel focus transfer;
- English and Canadian French with no mixed-language operational screen;
- error association and recovery without colour-only meaning.

Record OS, assistive technology/version, theme, scaling, locale, result, issue ID and evidence. Automation cannot certify screen-reader usability or human comprehension.
