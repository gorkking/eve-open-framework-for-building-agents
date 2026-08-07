import type { Metadata } from "next";
import { BlogPostLayout } from "@/app/[lang]/blog/blog-post-layout";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { translations } from "@/geistdocs";
import { dynamicCapabilitiesPost as post } from "@/lib/blog/posts";
import Content from "./content.mdx";

export const metadata: Metadata = {
  title: post.title,
  description: post.description,
  authors: [{ name: post.author.name, url: post.author.accounts.github.href }],
  openGraph: {
    type: "article",
    title: post.title,
    description: post.description,
    images: [
      {
        url: post.image,
        width: 2400,
        height: 1256,
        alt: post.imageAlt,
      },
    ],
    publishedTime: post.publishedAt,
    authors: [post.author.accounts.github.href],
  },
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

export default function BlogPost() {
  return (
    <BlogPostLayout post={post}>
      <Content components={getMDXComponents()} />
    </BlogPostLayout>
  );
}
