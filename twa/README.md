# Native .apk via Bubblewrap/TWA

Wraps the GitHub Pages–hosted PWA (`.github/workflows/pages.yml`) as a Trusted
Web Activity. **This step needs tools this sandbox doesn't have — JDK 17+ and
the Android SDK — so it must run on your own machine, not here.** Everything
up to this folder (the PWA itself, the Pages deploy) is already built and
verified; this README is what's left.

## One-time setup (your machine)

```
npm install -g @bubblewrap/cli
cd twa
bubblewrap build --manifest=twa-manifest.json
```

The first `build` generates and signs `app-release-signed.apk`, creating
`android.keystore` next to `twa-manifest.json` if it doesn't exist yet.
**Back up that keystore file somewhere safe outside git — if you lose it you
can never ship an update to the same `packageId` again.** It's gitignored on
purpose; don't commit it.

## Before it can hide the URL bar: the asset-link gotcha

Chrome only drops the URL bar (Digital Asset Links verified) when
`https://alexgaledo.github.io/.well-known/assetlinks.json` — at the **domain
root**, not under `/planliftar-thesis/` — serves a file naming this APK's
signing certificate fingerprint. That path is controlled by whichever repo
owns `alexgaledo.github.io` itself (a GitHub user-page repo), which is a
*different* repo from this one and may not exist yet.

Two ways to resolve this, pick one before relying on "no URL bar" for the
defense demo:
- Create (or reuse) the `AlexGaledo/alexgaledo.github.io` repo and publish
  `.well-known/assetlinks.json` there with the fingerprint from
  `bubblewrap build`'s output (it prints the SHA-256 after signing).
- Or point `host`/`webManifestUrl`/`fullScopeUrl` in `twa-manifest.json` at a
  custom domain you control the root of instead of `*.github.io`.

Until one of those is done, the APK still installs and the AR content still
loads fully offline from the precache (see `features/offline-apk.md`) — it
just shows a browser URL bar at the top instead of looking fully native. Not
a functional blocker, just a cosmetic one worth knowing about before demo day.

## Verifying the result

1. Install the signed APK on a real Android device (`adb install
   app-release-signed.apk`).
2. Follow the offline checks in `features/offline-apk.md` ("How to prove it
   works") — airplane mode, preloaded plan, cold start after clearing app
   storage.
