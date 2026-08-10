# @chatpack/file

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
