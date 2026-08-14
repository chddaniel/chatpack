/**
 * The `@chatpack/*` versions that generated starters pin.
 *
 * Starters pin exact versions so a generated app is reproducible. That makes
 * this set load-bearing in a way a caret range would not be: core's required
 * `StorageAdapter` contract grows across minors, so a core newer than its
 * adapter is not merely untested, it fails. The three versions below must
 * always name one published, mutually compatible release set.
 *
 * `test/versions.test.ts` asserts these match the monorepo's own package
 * versions. Because `changeset version` bumps those right before publishing,
 * that test is what fails when a release would otherwise ship a starter
 * pinning a version that does not exist on npm yet.
 */
export const chatpackVersions = {
  CHATPACK_CORE_VERSION: "0.12.0",
  CHATPACK_CLIENT_VERSION: "0.8.0",
  CHATPACK_ADAPTER_DRIZZLE_VERSION: "0.9.0",
} as const;

/** The workspace package each pin above is expected to track. */
export const versionTokenSources: Record<keyof typeof chatpackVersions, string> = {
  CHATPACK_CORE_VERSION: "core",
  CHATPACK_CLIENT_VERSION: "client",
  CHATPACK_ADAPTER_DRIZZLE_VERSION: "adapter-drizzle",
};
