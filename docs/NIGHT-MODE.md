# Reader night mode and clarity pass

## Scope

The reader keeps its cream-and-forest day palette and original RuneScape-inspired artwork. Night mode uses dark forest surfaces, warm paper-coloured text, and related metal/rune colours for every encounter and combat style. Imported guide text uses neutral reading colours rather than the surrounding encounter accent.

The page hierarchy, guide inventory, source records, external media, local routes, saved hubs, reading checklist, search, motion controls, native disclosures, and twelve encounter illustrations are retained. No source article content is rewritten by this pass.

## Preference contract

- The shared preference key is `localStorage['pvme-theme']`.
- Valid values are `system`, `light`, and `dark`. This night-mode release opens in Night (`dark`) when the value is missing, invalid, or inaccessible. Existing saved Day (`light`) and System choices are preserved. The default does not write to storage.
- The native header select is labelled **Color theme**, with **System**, **Day**, and **Night** options.
- `html[data-theme]` records the resolved `light` or `dark` mode. `html[data-theme-preference]` records the chosen preference.
- System appearance changes apply only when System is selected. Storage events synchronize other tabs/windows. Returning through the back-forward cache reconciles the preference.
- Storage errors never prevent switching. The current document keeps its in-memory choice, including back-forward cache restoration, but cannot promise persistence to another document.
- `src/night-mode.js` is a small classic script before the stylesheets. It resolves the preference during parsing, avoiding a light-theme frame while module scripts load.
- CSS `color-scheme` and `light-dark()` also use Night without JavaScript. The unavailable control remains hidden. With JavaScript, selecting System follows the operating system. Printing explicitly uses light colours.
- This stylesheet targets modern browsers with CSS `light-dark()` support. It adds no runtime dependency or third-party request.

The editor uses the same stored values and resolved attribute. It owns its own stylesheet and controls.

## Concrete clarity changes

- Replaced promotional labels and abstract slogans with specific learning, gear, source, and empty-state labels.
- Removed repeated “READ HERE” labels, repeated guide-group descriptions on every row, “one hub” filler, fake path-number tabs, and decorative difficulty ticks.
- Encounter cards show the actual learning focus instead of an arbitrary catalogue number and a sideways caption.
- Removed redundant inset frames and repeated coloured top strips. Original rune drawings and encounter colours remain.
- Internal navigation arrows no longer imply a new external destination.
- Removed self-descriptive design copy from About. Attribution, licensing, source-capture warnings, and limitations remain.
- Improved focus visibility on inline search and the search dialog input. Day-mode muted text was slightly darkened to meet the tested contrast pairs.

The pass does not reintroduce decorative left accent bars. Structural table-of-contents and column separators remain.

## Verification

Run `npm test` from the repository root. It performs the clean default reader build and calls `scripts/test_night_mode.mjs` alongside the existing archive, source-preservation, security, motion, ambient, route, packaging, and deterministic-rebuild checks.

The night-mode suite executes the real preference script against small DOM/storage/media-query doubles. It verifies:

- theme resolution before DOM-ready;
- first-visit Night, preserved saved Day/System preferences, explicit overrides, and OS changes;
- invalid saved values, blocked storage, cross-document updates, and back-forward cache restoration;
- all 21 section, encounter, and combat-style day/night palettes;
- at least 4.5:1 contrast for authored normal-text/surface pairs and theme accent/pale/wash pairs;
- at least 3:1 focus indicator contrast against the page;
- shell asset order, progressive enhancement, exact asset copies, and removed redundant labels.

These calculations cover authored colour pairs. They are not a full rendered-page accessibility audit, nor a claim about text baked into external images or videos.

### Browser checks completed

Chromium through the managed local preview, before the later first-visit Night-default adjustment:

- Desktop home, Vindicta encounter hub, full Vindicta article, in-page heading navigation, and search dialog/results.
- Night selection persisting between home, hub, and reader navigation.
- Day and Night appearance of the 320px home and 390px reader, using fixed-width iframe viewports. Measured content widths were 305px and 375px after scrollbars; scroll widths matched, with no document-level horizontal overflow.
- Theme control remains visible beside search, navigation, motion, and Wiki controls at those narrow widths.
- Cross-document preference changes update the other open document.
- Mobile navigation opens, Escape dismisses it, and focus returns to its trigger.
- Returning to System restores the environment's light preference.

A temporary responsive harness was placed only in `dist/night-qa.html`. A clean build removes it. Never publish a manually modified `dist` without rebuilding.

### Remaining coverage limits

No physical iOS/Android device or Safari/Firefox pass was run. Operating-system appearance transitions, storage denial, back-forward-cache lifecycle, no-JavaScript colours, and print styling are contract/source checks rather than browser-emulated tests. First-paint ordering is structurally tested; a throttled-network filmstrip was not captured. Hosting and authenticated contributor-workflow checks belong to the full-stack integration pass.

The later first-visit Night-default adjustment was checked with the preference/contrast suite, including null storage, blocked storage, preserved System/Day, and OS changes. It does not change the palette or page layout; the integrated release still needs its final browser smoke test.
