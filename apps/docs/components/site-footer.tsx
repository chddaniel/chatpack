import Link from "next/link";
import { appName, communityLinks } from "@/lib/shared";

const groups = [
  {
    heading: "Docs",
    links: [
      { text: "Quickstart", href: "/docs/quickstart" },
      { text: "Concepts", href: "/docs/concepts/architecture" },
      { text: "REST reference", href: "/docs/reference/rest-api" },
      { text: "Packages", href: "/docs/reference/packages" },
    ],
  },
  {
    heading: "Community",
    links: [
      { text: "Discord", href: communityLinks.discord },
      { text: "X", href: communityLinks.x },
      { text: "GitHub Discussions", href: communityLinks.discussions },
    ],
  },
  {
    heading: "Project",
    links: [
      { text: "GitHub", href: communityLinks.github },
      { text: "npm", href: communityLinks.npm },
      { text: "Roadmap", href: "/docs/project/roadmap" },
      { text: "Credits", href: "/docs/project/credits" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t bg-fd-card">
      <div className="mx-auto grid w-full max-w-5xl grid-cols-2 gap-8 px-6 py-10 sm:grid-cols-3">
        {groups.map((group) => (
          <div key={group.heading}>
            <h2 className="text-sm font-semibold">{group.heading}</h2>
            <ul className="mt-3 space-y-2 text-sm text-fd-muted-foreground">
              {group.links.map((link) => (
                <li key={link.text}>
                  {link.href.startsWith("/") ? (
                    <Link href={link.href} className="hover:text-fd-foreground transition-colors">
                      {link.text}
                    </Link>
                  ) : (
                    <a
                      href={link.href}
                      rel="noreferrer noopener"
                      className="hover:text-fd-foreground transition-colors"
                    >
                      {link.text}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto w-full max-w-5xl px-6 pb-10 text-sm text-fd-muted-foreground">
        {appName} is MIT licensed. Building something with it?{" "}
        <a
          href={communityLinks.discord}
          rel="noreferrer noopener"
          className="underline hover:text-fd-foreground transition-colors"
        >
          Come say hi on Discord
        </a>
        .
      </div>
    </footer>
  );
}
