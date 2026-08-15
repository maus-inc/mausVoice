// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";

const docsSite = "https://maus-inc.github.io";
const docsBase = "/mausVoice/docs/";
const socialImage = `${docsSite}${docsBase}assets/mausvoice-banner.png`;

/**
 * @param {Record<string, string>} attrs
 * @returns {{ tag: "meta", attrs: Record<string, string> }}
 */
const meta = (attrs) => ({ tag: "meta", attrs });

const sidebar = [
  ["Getting started", "getting-started"],
  ["Using mausVoice", "using-mausvoice"],
  ["Configuration", "configuration"],
  ["Providers", "providers"],
  ["Privacy & security", "privacy-security"],
  ["Troubleshooting", "troubleshooting"],
  ["Reference", "reference"],
  ["Development", "development"],
  ["Project", "project"],
].map(([label, directory]) => ({ label, autogenerate: { directory } }));

// https://astro.build/config
export default defineConfig({
  site: docsSite,
  base: docsBase,
  integrations: [
    starlight({
      title: "mausVoice Docs",
      disable404Route: true,
      description:
        "Official documentation for mausVoice, the cross-platform voice-to-text desktop app.",
      logo: {
        src: "./src/assets/logo.png",
      },
      favicon: "/favicon.png",
      social: [
        {
          icon: "github",
          label: "mausVoice on GitHub",
          href: "https://github.com/maus-inc/mausVoice",
        },
      ],
      lastUpdated: true,
      editLink: {
        baseUrl: "https://github.com/maus-inc/mausVoice/edit/main/apps/docs/",
      },
      head: [
        meta({
          name: "robots",
          content:
            "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
        }),
        meta({ property: "og:site_name", content: "mausVoice Docs" }),
        meta({ property: "og:locale", content: "en_US" }),
        meta({ property: "og:image", content: socialImage }),
        meta({ property: "og:image:secure_url", content: socialImage }),
        meta({ property: "og:image:type", content: "image/png" }),
        meta({ property: "og:image:width", content: "1684" }),
        meta({ property: "og:image:height", content: "764" }),
        meta({
          property: "og:image:alt",
          content: "mausVoice — your voice, typed anywhere",
        }),
        meta({ name: "twitter:card", content: "summary_large_image" }),
        meta({ name: "twitter:image", content: socialImage }),
        meta({
          name: "twitter:image:alt",
          content: "mausVoice — your voice, typed anywhere",
        }),
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "text/plain",
            href: `${docsSite}${docsBase}llms.txt`,
            title: "mausVoice documentation for language models",
          },
        },
      ],
      customCss: ["./src/styles/custom.css"],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      sidebar,
    }),
    sitemap(),
  ],
});
