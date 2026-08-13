# @chatpack/cli

## 0.2.1

### Patch Changes

- Fill in the `author` and `contributors` metadata, which was empty on every
  published package. Yeabsra Habtu is credited as author (principal author of the
  library), with chddaniel, Ikem Peter and chhddavid as contributors. Registry
  maintainers and publish rights are unchanged. No runtime or API changes —
  package metadata only, so authorship shows up on npm and in registry mirrors.

## 0.2.0

### Minor Changes

- db082b7: Add participant-scoped message search actions and React hooks to the client.

  Bundle TypeScript in the CLI and refresh generated clients for the current Chatpack API. The
  compiler bundle raises the package tarball from about 93 KB to 2.1 MB while avoiding the roughly
  40 MB TypeScript runtime install.

## 0.1.0

### Minor Changes

- 21a6d35: Add the initial `chatpack init` CLI for safe Chatpack setup in Next.js, Hono,
  and Express projects.
