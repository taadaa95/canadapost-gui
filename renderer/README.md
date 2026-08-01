# Renderer module ownership

Load order is explicit in `index.html`:

1. `base.css` owns tokens, themes, page geometry, workflow layout and responsive rules migrated from the former inline stylesheet.
2. `components.css` owns small independently testable overlays, privacy controls, queue states and update progress.
3. `shared-context.js` owns the mutable cross-feature state object and event interface.
4. Feature modules own Step 2 copy, Step 3 queue selection, privacy-data management and update progress.
5. `renderer.js` remains the compatibility composition root while feature extraction continues; it must communicate cross-feature changes through `RendererContext.events` rather than new implicit globals.

Do not add inline styles, a new historical override block, or feature state directly to HTML. Prefer the lowest-specificity rule that preserves behavior. `!important` remains legacy debt; new uses require a behavioral reason and test. The generic hidden-state rule is intentionally forceful for accessibility and native-browser safety.
