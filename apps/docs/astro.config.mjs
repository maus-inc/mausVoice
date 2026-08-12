// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://maus-inc.github.io/mausVoice",
  integrations: [
    starlight({
      title: "mausVoice Docs",
      logo: {
        src: "./src/assets/logo.png",
      },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
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
      ],
    }),
    sitemap(),
  ],
});
