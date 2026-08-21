import Link from "next/link";
import { trustPages } from "@/lib/trust/pages";

const projectLinks = [
  ...trustPages.map((page) => ({ href: `/${page.slug}`, label: page.title })),
  { href: "/openapi.json", label: "Documentation API" },
  { href: "https://github.com/vercel/eve", label: "GitHub" },
];

export const SiteFooterLinks = () => (
  <nav
    aria-label="eve project information"
    className="mx-auto w-full max-w-[1448px] border-t px-6 pt-10"
  >
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <span className="font-medium text-gray-1000 text-label-14">eve project</span>
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-label-14">
        {projectLinks.map((link) => (
          <li key={link.href}>
            <Link className="text-gray-900 transition-colors hover:text-gray-1000" href={link.href}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  </nav>
);
