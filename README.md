# fabius-bridge-releases

Release feed for the Fabius bridge, the small program that runs one person's Fabius bot against
HQ. Every installed bridge reads `manifest.json` here at start and every few hours; when the
version is newer it downloads the files, verifies each sha256, syntax-checks them, swaps itself
and restarts. Nobody pulls by hand.

Contents: `fabius-bridge.mjs`, `say.cjs`, `manifest.json`. Never a config, never a key.
Source and release script: the private `bigsby-bridge` repo (`./release.sh`).
