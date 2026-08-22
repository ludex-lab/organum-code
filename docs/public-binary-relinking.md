# Public binary relinking materials

Status: required distribution material for Organum Code standalone archives.
This document records the exact source and rebuild coordinates; it is not legal
advice and does not replace platform code signing or notarization.

## Why this is included

The Organum Code standalone is produced by Bun's `--compile` mode. Bun itself
is MIT-licensed, but Bun 1.3.14 statically links JavaScriptCore and WebKit
components covered by the GNU Library General Public License version 2. The
binary archive therefore carries all of the following as ordinary, extractable
files:

- this `RELINKING.md`;
- Bun 1.3.14's complete pinned `LICENSE.md` as `BUN-LICENSE.md`;
- JavaScriptCore's complete pinned `COPYING.LIB` as
  `JAVASCRIPTCORE-LGPL-2.0.txt`;
- `THIRD_PARTY_NOTICES.txt` and the Organum Code MIT `LICENSE`;
- `relink.json`, which binds these materials to the exact application, Bun,
  and WebKit source revisions.

The matching public Release page must also carry the exact Organum Code source
archive named by `relink.json`. Source and relinking material are offered from
the same public release surface as every platform binary. Organum Code's MIT
terms do not prohibit modification for a recipient's own use or reverse
engineering for debugging modifications to the covered library.

## Frozen upstream coordinates

- Bun repository: `https://github.com/oven-sh/bun.git`
- Bun tag: `bun-v1.3.14`
- Bun commit: `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`
- patched WebKit repository: `https://github.com/oven-sh/WebKit.git`
- WebKit commit pinned by that Bun revision:
  `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b`

The copies in the archive are byte-pinned. `relink.json` records their SHA-256
digests, and `bundle.json` independently binds every included payload.

## Rebuild with a modified JavaScriptCore

1. Extract the source archive from the same Organum Code Release page and
   verify its adjacent checksum.
2. Check out Bun and WebKit at the exact revisions above.
3. Modify WebKit/JavaScriptCore as desired.
4. Build Bun against that checkout using the upstream procedure recorded in
   the included `BUN-LICENSE.md`. That pinned document is authoritative for
   the exact Bun revision; it initializes Bun's recursive dependencies, builds
   JavaScriptCore, compiles Bun's C++ bindings, and emits a replacement Bun.
5. From the extracted Organum Code source, use the replacement Bun for every
   step rather than a system Bun:

```bash
MODIFIED_BUN=/absolute/path/to/modified/bun
"$MODIFIED_BUN" install --frozen-lockfile
"$MODIFIED_BUN" ./scripts/build-first-party-plugin.ts
"$MODIFIED_BUN" build ./src/main.ts --compile --minify \
  --outfile ./dist/organum-code
```

On Windows, use `organum-code.exe` as the output filename. The application
source, lockfile, generated-plugin builder, and TypeScript configuration needed
for this compilation are all present in the source archive. A modified runtime
may intentionally produce bytes different from the official checksum; it must
not be represented as an official Organum Code artifact.

## Source availability

The public source repository is `https://github.com/ludex-lab/organum-code`.
For a released binary, use only the source archive and commit named by that
binary's `relink.json`. Upstream source coordinates are content-addressed in the
same manifest so a moving branch is never part of the relink contract.
