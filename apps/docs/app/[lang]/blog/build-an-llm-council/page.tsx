import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { translations } from "@/geistdocs";
import { llmCouncilPost as post } from "@/lib/blog/posts";
import { BlogShareActions } from "./blog-share-actions";
import Content from "./content.mdx";

const postUrl = "https://eve.dev/blog/build-an-llm-council";
const accountClass =
  "inline-flex h-8 items-center gap-2 rounded-md border border-gray-alpha-400 bg-gray-100 px-3 text-[13px] font-medium text-gray-800 no-underline transition-colors hover:bg-gray-alpha-200 hover:text-gray-1000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 motion-reduce:transition-none";

export const metadata: Metadata = {
  title: post.title,
  description: post.description,
  authors: [{ name: post.author.name, url: post.author.accounts.github.href }],
  openGraph: {
    type: "article",
    title: post.title,
    description: post.description,
    images: [post.image],
    publishedTime: post.publishedAt,
    authors: [post.author.accounts.github.href],
  },
};

const Author = ({ compact = false }: { compact?: boolean }) => (
  <div className="flex items-center gap-3">
    <Image
      alt=""
      className="rounded-full border border-gray-alpha-400"
      height={compact ? 40 : 48}
      src={post.author.avatar}
      width={compact ? 40 : 48}
    />
    <div>
      {!compact && <p className="mb-0.5 text-[13px] text-gray-700">Written by</p>}
      <a
        className="font-medium text-gray-1000 no-underline hover:underline"
        href={post.author.accounts.github.href}
      >
        {post.author.name}
      </a>
      {!compact && <p className="mt-1 text-copy-14 text-gray-800">{post.author.bio}</p>}
    </div>
  </div>
);

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

export default function BlogPost() {
  return (
    <>
      <header className="border-b border-gray-alpha-400 bg-gray-100">
        <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 px-6 py-12 lg:grid-cols-2 lg:gap-16 lg:py-14">
          <div>
            <div className="mb-4 flex items-center gap-2.5 text-[13px] text-gray-800">
              <time dateTime={post.publishedAt}>{post.publishedLabel}</time>
              <span aria-hidden="true" className="text-gray-600">
                ·
              </span>
              <span>{post.readingTime}</span>
            </div>
            <h1 className="text-balance text-[36px] leading-[1.1] font-semibold tracking-[-0.04em] text-gray-1000 sm:text-[46px]">
              {post.title}
            </h1>
            <div className="mt-7">
              <Author compact />
            </div>
          </div>
          <div className="relative aspect-[2400/1256] overflow-hidden rounded-xl border border-gray-alpha-400 bg-black">
            <Image
              alt="Four model responses connected to a council answer and agreement scores"
              className="object-cover"
              fill
              priority
              sizes="(min-width: 1200px) 568px, (min-width: 960px) 46vw, 100vw"
              src={post.image}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1200px] items-start gap-16 px-6 py-16 lg:grid-cols-[minmax(0,720px)_260px] lg:gap-20 lg:py-20">
        <div className="min-w-0">
          <article className="prose min-w-0 max-w-none [&_p]:leading-7">
            <Content components={getMDXComponents()} />
          </article>

          <nav
            aria-label="Blog navigation"
            className="mt-16 flex items-center justify-between border-t border-gray-alpha-400 pt-8"
          >
            <Link
              className="inline-flex items-center gap-1.5 text-copy-14 text-gray-800 no-underline hover:text-gray-1000"
              href="/blog"
            >
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              Back to blog
            </Link>
          </nav>

          <section
            aria-label={`About ${post.author.name}`}
            className="mt-12 overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-100"
          >
            <div className="p-5">
              <Author />
            </div>
            <div className="flex flex-wrap gap-2 border-t border-gray-alpha-400 bg-background-100 px-5 py-3">
              <a
                className={accountClass}
                href={post.author.accounts.github.href}
                rel="noreferrer"
                target="_blank"
              >
                <svg
                  aria-hidden="true"
                  className="size-3.5"
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  <path
                    clipRule="evenodd"
                    d="M8 .13c-4.42 0-8 3.6-8 8.07 0 3.57 2.3 6.58 5.47 7.65.4.08.55-.17.55-.39L6 13.96c-2.23.49-2.7-.95-2.7-.95-.35-.94-.88-1.18-.88-1.18-.73-.5.05-.5.05-.5.8.06 1.23.84 1.23.84.72 1.22 1.87.88 2.33.66.07-.52.28-.88.5-1.08-1.77-.19-3.64-.88-3.64-3.98 0-.88.32-1.6.82-2.16-.07-.2-.35-1.03.08-2.14 0 0 .68-.21 2.2.83a7.7 7.7 0 0 1 4 0c1.53-1.04 2.2-.83 2.2-.83.45 1.11.17 1.94.09 2.14.52.56.82 1.28.82 2.16 0 3.1-1.87 3.78-3.66 3.98.3.26.54.74.54 1.5v2.21c0 .22.14.47.54.4A8.1 8.1 0 0 0 16 8.2 8 8 0 0 0 8 .13"
                    fillRule="evenodd"
                  />
                </svg>
                {post.author.accounts.github.label}
              </a>
              <a
                className={accountClass}
                href={post.author.accounts.x.href}
                rel="noreferrer"
                target="_blank"
              >
                <span aria-hidden="true" className="flex size-3.5 items-center justify-center">
                  𝕏
                </span>
                {post.author.accounts.x.label}
              </a>
              <a
                className={accountClass}
                href={post.author.accounts.linkedin.href}
                rel="noreferrer"
                target="_blank"
              >
                <svg
                  aria-hidden="true"
                  className="size-3.5"
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  <path d="M13.63 13.63h-2.37V9.92c0-.89-.02-2.03-1.24-2.03-1.24 0-1.43.97-1.43 1.96v3.78H6.22V6H8.5v1.04h.03a2.5 2.5 0 0 1 2.25-1.24c2.4 0 2.85 1.58 2.85 3.64zM3.54 4.96a1.38 1.38 0 1 1 0-2.75 1.38 1.38 0 0 1 0 2.75m1.19 8.67H2.35V6h2.38zM14.82.67H1.18C.53.67 0 1.18 0 1.82v13.7c0 .65.53 1.16 1.18 1.16h13.63c.65 0 1.19-.51 1.19-1.15V1.82c0-.64-.54-1.15-1.19-1.15z" />
                </svg>
                {post.author.accounts.linkedin.label}
              </a>
            </div>
          </section>

          <section aria-label="Share" className="mt-12 lg:hidden">
            <h2 className="mb-3 text-heading-14 text-gray-1000">Share</h2>
            <BlogShareActions title={post.title} url={postUrl} />
          </section>
        </div>

        <aside className="sticky top-24 hidden flex-col gap-8 lg:flex">
          <nav aria-label="In this article">
            <h2 className="mb-3 text-heading-14 text-gray-1000">In this article</h2>
            <ul className="flex list-none flex-col gap-2 border-l border-gray-alpha-400 p-0">
              {post.tableOfContents.map((item) => (
                <li key={item.href}>
                  <a
                    className="block pl-3.5 text-[13px] text-gray-800 no-underline hover:text-gray-1000"
                    href={item.href}
                  >
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <section aria-label="Share">
            <h2 className="mb-3 text-heading-14 text-gray-1000">Share</h2>
            <BlogShareActions title={post.title} url={postUrl} />
          </section>
        </aside>
      </main>
    </>
  );
}
