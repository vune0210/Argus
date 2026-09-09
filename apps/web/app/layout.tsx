import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Argus — Distributed uptime monitoring",
  description: "Monitor public services from multiple regions and coordinate the response.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
