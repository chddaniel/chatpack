# @chatpack/file

## 0.1.6

### Patch Changes

- 5d6f1c8: Add the community links (Discord, X, docs, Discussions) to every package README and to
  `llms.txt`, so the fastest way to reach the maintainers is on the npm page of whichever
  package you installed. No code changes.
- Updated dependencies [5d6f1c8]
- Updated dependencies [7803136]
  - @chatpack/core@0.12.0

## 0.1.5

### Patch Changes

- Credit the project's co-owners by name rather than GitHub handle in package
  `contributors` metadata and the credits surfaces: DanielCH and DavidCH.
- Updated dependencies
  - @chatpack/core@0.11.2

## 0.1.4

### Patch Changes

- Fill in the `author` and `contributors` metadata, which was empty on every
  published package. Yeabsra Habtu is credited as author (principal author of the
  library), with chddaniel, Ikem Peter and chhddavid as contributors. Registry
  maintainers and publish rights are unchanged. No runtime or API changes —
  package metadata only, so authorship shows up on npm and in registry mirrors.
- Updated dependencies
  - @chatpack/core@0.11.1

## 0.1.3

### Patch Changes

- Updated dependencies [172259f]
  - @chatpack/core@0.11.0

## 0.1.2

### Patch Changes

- 9287d75: Accept an empty-but-non-null request body on Filepack's `complete` and `abort`
  upload controls. Filepack rejects any non-null body on those two routes, and
  Next.js App Router hands route handlers a present-but-empty body, so completing
  an upload from a Next app failed with `INVALID_REQUEST` and hosts had to strip
  the body themselves. The plugin now normalizes it before forwarding. A body
  carrying real bytes is still forwarded untouched and still rejected;
  `parts/prepare` and `parts/record` genuinely take JSON and are unaffected.

  Docs: `llms.txt`, the README, and the docs site also gained the two rules that
  dogfooding turned up - `body` is required and non-empty on every message (there
  are no attachment-only messages), and `@filepack/client` <= 0.1.1 needs an
  explicit `controlFetch` to work in a browser. `llms.txt` also named a
  `createChatFileClient` export that never existed; the real name is
  `createChatpackFileClient`.

- Updated dependencies [9287d75]
  - @chatpack/core@0.10.0

## 0.1.1

### Patch Changes

- Updated dependencies [a9e6dd7]
  - @chatpack/core@0.9.0

## 0.1.0

### Minor Changes

- 06b4e67: Add blocking and trusted bearer-capability plugin hooks plus the `@chatpack/file`
  integration for Filepack-backed, conversation-authorized attachments. Capability
  dispatch is limited to exact Filepack transfer routes; control routes remain
  authenticated and unknown routes are not forwarded.

### Patch Changes

- Updated dependencies [06b4e67]
  - @chatpack/core@0.8.0

## 0.1.0

Initial release of the Filepack-backed Chatpack attachment plugin.
