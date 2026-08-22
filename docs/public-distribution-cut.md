# Public distribution cut

The anonymous binary release is deliberately separate from the public source
cut and from unsigned CI previews. `Stage Signed Release Candidate` is the only
admitted path for a distributable candidate. It refuses a non-`main` ref, an
incorrect version confirmation, missing platform credentials, failed
notarization/signing, archive smoke failure, or provenance failure.

The workflow does not create a GitHub Release. Its source, Linux, signed and
notarized macOS, and signed Windows artifacts expire after seven days. A release
operator must download all four artifact groups, verify their adjacent SHA-256
files and GitHub attestations, inspect the platform signatures, and only then
create a reviewed draft Release. Promoting that draft and adding the shared
Organum homepage download link are later explicit decisions.

## Required GitHub environment

Create a `public-release-signing` environment in `ludex-lab/organum-code`, add a
required reviewer, and store these environment secrets:

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_NOTARY_KEY_P8_BASE64`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_ISSUER_ID`
- `WINDOWS_CERTIFICATE_PFX_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

The Apple certificate must be a valid Developer ID Application identity. The
notary key is an App Store Connect API private key with the matching key and
issuer identifiers. The Windows PFX must contain a publicly trusted code-signing
certificate and private key. Do not commit, paste into issue text, or send any of
these private materials through Hub/relay messages.

On the operator Mac, availability can be checked without exposing private key
material:

```bash
security find-identity -v -p codesigning
```

Base64 secret bodies should be piped directly into `gh secret set` rather than
printed. Password secrets should be entered at the hidden interactive prompt:

```bash
base64 -i /absolute/path/to/developer-id.p12 | tr -d '\n' | \
  gh secret set APPLE_CERTIFICATE_P12_BASE64 \
    --repo ludex-lab/organum-code --env public-release-signing
gh secret set APPLE_CERTIFICATE_PASSWORD \
  --repo ludex-lab/organum-code --env public-release-signing
gh secret set APPLE_SIGNING_IDENTITY \
  --repo ludex-lab/organum-code --env public-release-signing

base64 -i /absolute/path/to/AuthKey_KEYID.p8 | tr -d '\n' | \
  gh secret set APPLE_NOTARY_KEY_P8_BASE64 \
    --repo ludex-lab/organum-code --env public-release-signing
gh secret set APPLE_NOTARY_KEY_ID \
  --repo ludex-lab/organum-code --env public-release-signing
gh secret set APPLE_NOTARY_ISSUER_ID \
  --repo ludex-lab/organum-code --env public-release-signing

base64 -i /absolute/path/to/windows-code-signing.pfx | tr -d '\n' | \
  gh secret set WINDOWS_CERTIFICATE_PFX_BASE64 \
    --repo ludex-lab/organum-code --env public-release-signing
gh secret set WINDOWS_CERTIFICATE_PASSWORD \
  --repo ludex-lab/organum-code --env public-release-signing
```

Run the candidate only after all eight secrets and environment protection are
present:

```bash
gh workflow run release-candidate.yml \
  --repo ludex-lab/organum-code \
  --ref main \
  -f confirm_version=0.1.0-preview.1
```

## Candidate verification

For every downloaded `.tar`, run its adjacent checksum and provenance checks:

```bash
shasum -a 256 -c organum-code-v0.1.0-preview.1-PLATFORM.tar.sha256
gh attestation verify organum-code-v0.1.0-preview.1-PLATFORM.tar \
  --repo ludex-lab/organum-code
```

Extract the macOS and Windows archives and verify the embedded executables on
their native platforms:

```bash
codesign --verify --strict --verbose=2 ./organum-code
spctl --assess --type execute --verbose=4 ./organum-code
```

```powershell
signtool verify /pa /v .\organum-code.exe
```

The `relink.json` in every binary archive must bind the same public commit and
source archive. The source archive and its checksum must be attached to the same
public Release as the binaries. No unsigned replacement, same-version byte
rebinding, or partial-platform fallback is admitted.
