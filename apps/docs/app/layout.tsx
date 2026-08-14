import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { Inter } from "next/font/google";
import type { Metadata } from "next";

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
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
