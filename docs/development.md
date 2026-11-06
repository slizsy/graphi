# Working on Graphi

There's no build toolchain to install. The extension is plain JavaScript, and the tests only need Ruby (the version that ships with macOS is fine) plus the browsers.

## Building

```sh
scripts/build.sh            # both browsers
scripts/build.sh firefox    # or just one
scripts/build.sh chrome
```

Each build copies `src/` and then the files from `platforms/<browser>/` on top, so the only per-browser files are the manifests and Chrome's PNG icons. If you change the SVG icons, regenerate the PNGs with `ruby scripts/make-icons.rb`.

Bump the version in **both** `platforms/firefox/manifest.json` and `platforms/chrome/manifest.json`. The build refuses to run if they don't match.

## How the two browsers differ

Most of the code doesn't care, but a few spots do:

- `src/shared/browser-shim.js` points `browser` at `chrome` on Chromium, so all code can use the promise-based `browser.*` API.
- `src/shared/platform.js` holds the remaining differences: Chrome's message listeners have to answer through `sendResponse`, Chrome can't change shortcuts from an extension, and the help text points to different settings pages.
- In `src/content/adapters.js`, Chromium doesn't fire `beforeinput` or `textInput` when an extension edits the page, while Firefox does. Graphi sends those events itself on Chromium, the same way the browser does for real typing. Without that, Slate, Lexical, Draft.js and Google Docs never see the text.
- Monaco on Chromium uses the EditContext API instead of a hidden textarea, so there's an `EditContextAdapter` for it.

## Tests

```sh
tests/run_all.sh                       # everything
ruby tests/firefox/e2e.rb takeover     # one group of a suite
ruby scripts/check-syntax.rb           # parse every JS file, quick sanity check
```

Firefox tests use your installed Firefox through its Marionette protocol. Chrome tests need Chrome for Testing, because regular Chrome no longer loads unpacked extensions from the command line:

```sh
scripts/get-chrome.sh                  # downloads it into tests/.browsers (git-ignored)
ruby tests/chrome/chrome_e2e.rb
ruby tests/chrome/editors_e2e.rb       # live editor sites, needs internet
```

Every suite uses a throwaway browser profile, never yours.

| Suite | What it checks |
| --- | --- |
| `unit/engine_test.rb` | 3,000 random texts and settings: the typing plan always reproduces the text exactly |
| `firefox/e2e.rb` | Starting from the popup and shortcuts, every kind of field, pause/resume/stop, resuming later, taking over mid-session, typos, speed accuracy, background tabs, frames |
| `firefox/docs_e2e.rb` | Google Docs and Slides input, against a Docs-style test page served as docs.google.com |
| `firefox/editors_e2e.rb` | Live ProseMirror, CodeMirror, Lexical, Slate, Quill, Draft.js and Monaco pages (`TYPOS=8` to stress corrections) |
| `firefox/report_e2e.rb` | Reports, charts, replay, the print layout, and a one-minute "finish in" run (`QUICK=1` skips it) |
| `firefox/breaks_e2e.rb` | Scheduled breaks |
| `firefox/private_e2e.rb` | Private windows, before and after the permission is granted |
| `firefox/lifecycle_e2e.rb` | The real toolbar popup, settings surviving a restart, the extension reloading |
| `firefox/xpi_test.rb` | The packaged `.xpi` installs and works |
| `chrome/chrome_e2e.rb` | The Chrome build: popup, service worker, fields, rich text, React, pause/resume/stop, the badge, Docs, reports, breaks, protected pages |
| `chrome/editors_e2e.rb` | The same live editors, in Chrome |

## Screenshots

`ruby scripts/screenshots.rb` regenerates the popup screenshots in `docs/screenshots/`.
