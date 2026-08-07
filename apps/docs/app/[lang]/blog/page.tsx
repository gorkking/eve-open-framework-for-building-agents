import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { translations } from "@/geistdocs";
import { dynamicCapabilitiesPost, llmCouncilPost } from "@/lib/blog/posts";

const title = "The latest eve news";
const description = "Guides and ideas for building durable AI agents with eve.";
const posts = [dynamicCapabilitiesPost, llmCouncilPost];

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const BlogPage = () => (
  <main className="mx-auto max-w-[1080px] px-4 pb-32 sm:px-6">
    <header className="pt-12 pb-8 sm:pt-16 sm:pb-10">
      <h1 className="text-heading-32 text-gray-1000 sm:text-heading-40">{title}</h1>
    </header>

    <section aria-label="Blog posts">
      <ul className="flex list-none flex-col gap-4 p-0">
        {posts.map((post) => (
          <li key={post.href}>
            <Link
              className="flex h-full flex-col rounded-lg border border-gray-alpha-400 bg-background-100 no-underline outline-none transition-colors hover:border-gray-alpha-500 hover:bg-gray-alpha-100 focus-visible:border-gray-alpha-600 focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 focus-visible:ring-offset-background-100 motion-reduce:transition-none"
              href={post.href}
            >
              <div className="flex flex-1 flex-col p-6">
                <h2 className="text-heading-20 text-gray-1000">{post.title}</h2>
                <p className="mt-3 max-w-[720px] text-copy-16 text-gray-800">{post.description}</p>
                <div className="mt-6 flex items-center gap-2 text-copy-14 text-gray-800">
                  <Image
                    alt=""
                    className="rounded-full"
                    height={20}
                    src={post.author.avatar}
                    width={20}
                  />
                  <span>{post.author.name}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={post.publishedAt}>{post.publishedLabel}</time>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  </main>
);

export default BlogPage;
