export const appName = "Chatpack";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const gitConfig = {
  user: "chddaniel",
  repo: "chatpack",
  branch: "main",
};

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** Every public Chatpack link, in one place - nav, footer, and page metadata all read these. */
export const communityLinks = {
  discord: "https://discord.gg/gY3GCTRv5Y",
  x: "https://x.com/chatpackdev",
  xHandle: "@chatpackdev",
  npm: "https://www.npmjs.com/package/@chatpack/core",
  github: githubUrl,
  discussions: `${githubUrl}/discussions`,
};
