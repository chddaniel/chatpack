import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { Inter } from "next/font/google";
import type { Metadata } from "next";
import { appName, communityLinks } from "@/lib/shared";
import { SiteFooter } from "@/components/site-footer";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://docs.chatpack.dev"),
  title: {
    template: "%s | Chatpack",
    default: "Chatpack - open-source chat infrastructure for developers",
  },
  description:
    "Install a package, wire up your database and auth, and get a production-ready chat backend - 1:1 and group conversations, messages, permissions, read-state, and real-time delivery.",
  authors: [
    { name: "Yeabsra Habtu", url: "https://github.com/Yeabsra-Habtu" },
    { name: "Ikem Peter", url: "https://github.com/ikemHood" },
    { name: "DavidCH", url: "https://github.com/chhddavid" },
  ],
  creator: "DanielCH and DavidCH",
  publisher: "DanielCH and DavidCH",
  twitter: {
    card: "summary_large_image",
    site: communityLinks.xHandle,
    creator: communityLinks.xHandle,
  },
};

/**
 * schema.org `sameAs` - the machine-readable half of the community links. Crawlers and
 * assistants use it to tie the docs site to the Discord, X account, repo, and npm org.
 */
const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: appName,
  url: "https://docs.chatpack.dev",
  sameAs: [communityLinks.github, communityLinks.discord, communityLinks.x, communityLinks.npm],
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
        <RootProvider>
          {children}
          <SiteFooter />
        </RootProvider>
      </body>
    </html>
  );
}
