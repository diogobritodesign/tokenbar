# Contributing

**English** · [Português](CONTRIBUTING.pt-BR.md)

Issues and pull requests are welcome, in English or Portuguese. By
contributing you agree that your contribution is licensed under
[GPL-3.0-or-later](LICENSE), like the rest of the project.

## Ground rules

- **Never impersonate another client.** TokenBar reads what each tool already
  stores on your machine and identifies itself honestly (`tokenbar/x.y`). A
  provider that only answers to a spoofed User-Agent or to another app's OAuth
  client is out of scope.
- **Read-only.** The collector never writes to a tool's own files and never
  refreshes someone else's token.
- **No secrets on disk or in logs.** `tests/collect.test.js` enforces this for
  everything the collector writes.
- **Nothing heavy in the shell process.** The extension only reads
  `state.json` (asynchronously) and draws; all I/O and network lives in the
  collector.

## Running the tests

```sh
npm test                 # collector + pure formatting logic (Node, no GNOME needed)
scripts/ui-test.sh       # drives the real extension in an isolated headless GNOME Shell
scripts/preview.sh --demo  # opens a nested shell window with demo data
```

`scripts/ui-test.sh` needs GNOME Shell 48+ installed. It runs in its own D-Bus
session with temporary config/cache/data directories, so it does not touch
your running session or your settings.

## Adding a provider

1. Add `collector/src/providers/<name>.js` exporting an array of objects with
   `id`, `label`, `name`, `exists()`, `fetchLimits()` and `usageToday()`.
   Throw `CollectError(status, message)` with a short user-facing message.
2. Register it in `listProviders()` in `collector/src/collect.js`.
3. Export the pure response-mapping function and cover it in
   `tests/providers.test.js`.

Windows are `{ kind, label, usedPct, resetsAt, windowMinutes?, group? }`.

## Translations

Interface strings live in `extension/tokenbar@tokenbar/lib/i18n.js` and the
collector's messages in `collector/src/i18n.js`, as `[portuguese, english]`
pairs. `tests/i18n.test.js` fails if a key is missing a language, if the
placeholders differ, or if the code uses a key that is not in the table.

## Updating prices

Per-model API prices live in `collector/src/pricing.js`. Update the table and
the "checked on" date together, and adjust `tests/pricing.test.js`.
