// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";

const docsSite = "https://maus-inc.github.io";
const docsBase = "/mausVoice/";
const socialImage = `${docsSite}${docsBase}docs/assets/mausvoice-banner.png`;

/**
 * @param {Record<string, string>} attrs
 * @returns {{ tag: "meta", attrs: Record<string, string> }}
 */
const meta = (attrs) => ({ tag: "meta", attrs });

/**
 * @param {string} label
 * @param {string[][]} items
 * @returns {{ label: string, collapsed: true, items: { label: string, slug: string }[] }}
 */
const collapsedSection = (label, items) => ({
  label,
  collapsed: true,
  items: items.map(([itemLabel, slug]) => ({ label: itemLabel, slug })),
});

const enterpriseSidebar = [
  { label: "Overview", slug: "enterprise/overview" },
  collapsedSection("Managed Cloud", [
    ["Setup", "enterprise/managed-cloud/setup"],
    ["Renewal", "enterprise/managed-cloud/renewal"],
  ]),
  collapsedSection("Self-Hosted Cloud", [
    ["Setup", "enterprise/self-hosted-cloud/setup"],
    ["AWS", "enterprise/self-hosted-cloud/aws"],
    ["GCP", "enterprise/self-hosted-cloud/gcp"],
    ["Azure", "enterprise/self-hosted-cloud/azure"],
    ["Updates & Renewal", "enterprise/self-hosted-cloud/renewal"],
  ]),
  collapsedSection("On-Premise", [
    ["Setup", "enterprise/on-premise/setup"],
    ["Local Transcription", "enterprise/on-premise/transcription"],
    ["Local Post-Processing", "enterprise/on-premise/post-processing"],
    ["Updates & Renewal", "enterprise/on-premise/renewal"],
  ]),
  collapsedSection("Admin Portal", [
    ["Overview", "enterprise/admin-portal/overview"],
    ["Users", "enterprise/admin-portal/users"],
    ["Global Dictionary", "enterprise/admin-portal/global-dictionary"],
    ["Global Styles", "enterprise/admin-portal/global-styles"],
    [
      "Transcription & AI Providers",
      "enterprise/admin-portal/transcription-providers",
    ],
    ["Settings", "enterprise/admin-portal/settings"],
  ]),
  collapsedSection("SSO", [
    ["Overview", "enterprise/sso/overview"],
    ["Azure Entra ID", "enterprise/sso/azure-entra-id"],
    ["Keycloak", "enterprise/sso/keycloak"],
  ]),
  collapsedSection("Deployment", [
    ["Microsoft Intune", "enterprise/deployment/intune"],
  ]),
];

const sidebar = [
  {
    label: "Getting Started",
    items: [
      { label: "Introduction", slug: "getting-started/introduction" },
      { label: "macOS", slug: "getting-started/macos" },
      { label: "Windows", slug: "getting-started/windows" },
      { label: "Linux", slug: "getting-started/linux" },
    ],
  },
  {
    label: "Guides",
    autogenerate: { directory: "guides" },
  },
  {
    label: "Enterprise",
    items: enterpriseSidebar,
  },
];

// https://astro.build/config
export default defineConfig({
  site: docsSite,
  base: docsBase,
  integrations: [
    starlight({
      title: "mausVoice Docs",
      description:
        "Official documentation for mausVoice, the cross-platform voice-to-text desktop app.",
      logo: {
        src: "./src/assets/logo.png",
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
      sidebar,
    }),
    sitemap(),
  ],
});
