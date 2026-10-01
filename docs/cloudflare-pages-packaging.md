# Cloudflare Pages artifact preparation

`scripts/prepare-cloudflare-pages.mjs` prepares a separate Pages tree from an
already-built client directory. It follows the repository implementation at
`9b2f66c688f78b84969d063d1ad8e0c454493d8c` and does not build the client,
upload R2 objects, or deploy Pages.

## Build-time URL contract

The client URLs are Vite build-time defines. Supply the same public values to
the client build and to the preparer. The preparer checks observable JavaScript
strings and rejects a visible mismatch; it never edits or retargets a built
bundle. The `--attest-build-urls` flag is a caller statement that the input
build was made with these exact values. The JSON report records that statement
separately from bundle evidence. Missing or partial evidence blocks deployment
readiness.

`DATA_BASE_URL` uses the same append behavior as `client/vite.config.ts`:
`DATA_BASE_URL + "/" + filename`. URL resolution against a base is deliberately
not used, so a final path prefix such as `/releases/fall-2026` remains in the
result. Values must be HTTPS URLs without credentials, query strings, fragments,
recognized credential patterns, dot segments, or encoded path separators.
`CARD_DATA_URL` must identify the selected
`card-data-<16 lowercase hex>.json` source, and that name must match the first
16 hex digits of the decoded card-data SHA-256. `ENGINE_WASM_URL` must identify
the content-addressed engine WASM filename used by the pinned release flow.

## Prepare a tree

Build the client first with the intended values. Then pass those exact values
to the preparer. The output directory must not exist; its parent must already
exist and contain no symlink components.

```sh
cd client
DATA_BASE_URL='https://data.example.test/releases/fall-2026' \
CARD_DATA_URL='https://data.example.test/releases/fall-2026/card-data-0123456789abcdef.json' \
ENGINE_WASM_URL='https://data.example.test/wasm/engine_wasm_bg-0123456789abcdef.wasm' \
pnpm build
cd ..

node scripts/prepare-cloudflare-pages.mjs \
  --input client/dist \
  --output /tmp/phase-pages-dist \
  --data-base-url 'https://data.example.test/releases/fall-2026' \
  --card-data-url 'https://data.example.test/releases/fall-2026/card-data-0123456789abcdef.json' \
  --engine-wasm-url 'https://data.example.test/wasm/engine_wasm_bg-0123456789abcdef.wasm' \
  --attest-build-urls > /tmp/phase-pages-report.json
```

The URL values above are examples; use the values from the genuine build. The
tool reads no environment files and makes no network requests. It writes the
deterministic JSON report to stdout, so keep any report file outside the Pages
output. Reports omit absolute input/output paths and timestamps, allowing
equivalent trees at different absolute paths to produce equal reports.

## What is copied and removed

The preparer requires `index.html`, every logical JSON listed in the pinned
root `data-files.json` (either its identity file or a valid Brotli companion),
and the configured content-addressed card corpus. It copies the pinned
`client/deploy/cloudflare-pages/_headers` into the new tree. An input `_headers`
is accepted only when it is byte-identical to that source.

Only root-level exact names are removed:

- Each exact `data-files.json` entry and its `.br` companion.
- `card-data.json` and `card-data.json.br`.
- `card-data-<16 lowercase hex>.json` and its `.br` companion, after validating
  the decoded content hash.
- `404.html` only when it is byte-identical to `index.html`.

Other files remain in the Pages tree, including similarly named card files and
files in nested directories. A distinct `404.html` stops preparation for an
explicit routing decision. When top-level `404.html` is absent, Cloudflare
Pages uses its SPA fallback behavior; GitHub Pages routing behavior is
different. The preparer does not create a replacement 404 page.

For a Brotli companion, the report records its compressed-byte size and SHA-256
separately from the decoded-content size and SHA-256. The intended public
object key remains the unsuffixed `.json` filename and the URL has no `.br`
suffix. The pinned release workflow serves Brotli bytes with
`Content-Encoding: br`. If only identity bytes are present, the report marks
the encoded-byte hash as absent and notes that the publisher-side Brotli
transform is still required; it does not invent a compressed hash.

Every locally referenced WASM must exist and is copied unchanged. The report
hashes local WASM files. An externally configured engine WASM may be absent
from the build tree; in that case its byte size/hash and URL correspondence are
reported as unverified. A filename hash prefix alone is not evidence of the
remote bytes.

## Validation and limits

Input and output must be separate non-nested directories. Symlinks and special
filesystem entries are rejected. Existing destinations are never overwritten.
The preparer validates the copied output tree after copying and removes its
newly created partial output if a final-tree check fails.

The final Pages tree, including `_headers`, must contain no file larger than
26,214,400 bytes and no more than 20,000 files. These are the current Cloudflare
Pages Free plan limits documented in [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).
Cloudflare's [serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/)
documents the SPA fallback in the absence of top-level `404.html`.

Run the built-in tests and syntax check with:

```sh
node --test scripts/prepare-cloudflare-pages.test.mjs
node --check scripts/prepare-cloudflare-pages.mjs
```

Fixture tests establish the preparer's behavior only. Separately record whether
a genuine client build and preparation run passed or was blocked by missing
repository build inputs. A successful fixture run is not a deployable game.

## Operator verification remains necessary

The report proposes public URLs and object keys from the supplied configuration
and the pinned Vite/release contract. It cannot establish URL ownership, R2
bucket routing, object existence, response headers, or that the remote engine
WASM matches the URL. `deploymentReadiness` therefore remains blocked pending
operator verification of those external facts, even when bundle evidence
matches. No report field certifies a deployment or free-tier operation.
