import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, communityLinks, githubUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <MessageMark />
          {appName}
        </>
      ),
    },
    links: [
      {
        text: "Documentation",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "Community",
        url: communityLinks.discord,
        external: true,
      },
    ],
    githubUrl,
  };
}

function MessageMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
