import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stock Auto Trader",
  description: "Next.js stock auto trading dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
