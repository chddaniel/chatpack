import type { ReactNode } from "react";

export const metadata = {
  title: "Chatpack demo backend",
  description: "Public demo Chatpack backend for building copy-paste chat UI blocks.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          lineHeight: 1.6,
          maxWidth: "46rem",
          margin: "0 auto",
          padding: "2.5rem 1.25rem 4rem",
          color: "#18181b",
        }}
      >
        {children}
      </body>
    </html>
  );
}
