import type { Metadata } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: "Page not found - eve",
  description: "The requested eve documentation page does not exist.",
};

const GlobalNotFound = () => (
  <html lang="en">
    <body className="flex min-h-screen items-center justify-center bg-background-100 px-6 text-gray-1000">
      <main className="max-w-xl text-center">
        <h1 className="text-heading-32">Page not found</h1>
        <p className="mt-3 text-copy-16 text-gray-900">
          The requested page does not exist. Use the documentation map or agent index to find the
          current eve page.
        </p>
        <nav aria-label="Page recovery" className="mt-6 flex flex-wrap justify-center gap-3">
          <a className="inline-flex rounded-md border px-4 py-2 text-label-14" href="/sitemap.md">
            Documentation map
          </a>
          <a className="inline-flex rounded-md border px-4 py-2 text-label-14" href="/llms.txt">
            Agent index
          </a>
          <a
            className="inline-flex rounded-md border px-4 py-2 text-label-14"
            href="/docs/getting-started"
          >
            Getting started
          </a>
        </nav>
      </main>
    </body>
  </html>
);

export default GlobalNotFound;
