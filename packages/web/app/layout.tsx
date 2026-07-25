import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Handoff Protocol — durable agent sessions",
  description:
    "A protocol and reference implementation for serializing, transferring, and metering a running agent session across compute hosts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="top">
          <div className="wrap">
            <Link href="/" className="brand">
              <span className="dot" />
              handoff-protocol
            </Link>
            <div className="links">
              <Link href="/dashboard">dashboard</Link>
              <Link href="/docs">design doc</Link>
              <a href="https://github.com/zordhalo/agent-handoff-protocol" target="_blank" rel="noreferrer">
                github
              </a>
            </div>
          </div>
        </nav>
        {children}
        <footer>
          <div className="wrap">
            handoff-protocol — MIT licensed reference implementation. Not a claim that any model
            exhibits agency; see{" "}
            <Link href="/docs">design doc §5</Link> for the line between mechanism and narrative.
          </div>
        </footer>
      </body>
    </html>
  );
}
