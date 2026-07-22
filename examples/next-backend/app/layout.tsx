import type { ReactNode } from "react";

export const metadata = {
  title: "Chatpack — Next.js backend example",
  description: "A minimal Next.js App Router backend running Chatpack.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, monospace", padding: "2rem" }}>{children}</body>
    </html>
  );
}
