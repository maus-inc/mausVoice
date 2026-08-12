// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
	site: 'https://maus-inc.github.io',
	base: '/mausVoice/',
	integrations: [
		starlight({
			title: 'mausVoice Docs',
			description: 'Official documentation for mausVoice, the cross-platform voice-to-text desktop app.',
			logo: {
				src: './src/assets/logo.png',
			},
			head: [
				{
					tag: 'meta',
					attrs: {
						name: 'robots',
						content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
					},
				},
				{ tag: 'meta', attrs: { property: 'og:site_name', content: 'mausVoice Docs' } },
				{ tag: 'meta', attrs: { property: 'og:locale', content: 'en_US' } },
				{
					tag: 'meta',
					attrs: { property: 'og:image', content: 'https://maus-inc.github.io/mausVoice/docs/assets/mausvoice-banner.png' },
				},
				{
					tag: 'meta',
					attrs: { property: 'og:image:secure_url', content: 'https://maus-inc.github.io/mausVoice/docs/assets/mausvoice-banner.png' },
				},
				{ tag: 'meta', attrs: { property: 'og:image:type', content: 'image/png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1684' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '764' } },
				{
					tag: 'meta',
					attrs: { property: 'og:image:alt', content: 'mausVoice — your voice, typed anywhere' },
				},
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
				{
					tag: 'meta',
					attrs: { name: 'twitter:image', content: 'https://maus-inc.github.io/mausVoice/docs/assets/mausvoice-banner.png' },
				},
				{
					tag: 'meta',
					attrs: { name: 'twitter:image:alt', content: 'mausVoice — your voice, typed anywhere' },
				},
				{
					tag: 'link',
					attrs: {
						rel: 'alternate',
						type: 'text/plain',
						href: 'https://maus-inc.github.io/mausVoice/llms.txt',
						title: 'mausVoice documentation for language models',
					},
				},
			],
			customCss: ['./src/styles/custom.css'],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'macOS', slug: 'getting-started/macos' },
						{ label: 'Windows', slug: 'getting-started/windows' },
						{ label: 'Linux', slug: 'getting-started/linux' },
					],
				},
				{
					label: 'Guides',
					autogenerate: { directory: 'guides' },
				},
				{
					label: 'Enterprise',
					items: [
						{ label: 'Overview', slug: 'enterprise/overview' },
						{
							label: 'Managed Cloud',
							collapsed: true,
							items: [
								{ label: 'Setup', slug: 'enterprise/managed-cloud/setup' },
								{ label: 'Renewal', slug: 'enterprise/managed-cloud/renewal' },
							],
						},
						{
							label: 'Self-Hosted Cloud',
							collapsed: true,
							items: [
								{ label: 'Setup', slug: 'enterprise/self-hosted-cloud/setup' },
								{ label: 'AWS', slug: 'enterprise/self-hosted-cloud/aws' },
								{ label: 'GCP', slug: 'enterprise/self-hosted-cloud/gcp' },
								{ label: 'Azure', slug: 'enterprise/self-hosted-cloud/azure' },
								{ label: 'Updates & Renewal', slug: 'enterprise/self-hosted-cloud/renewal' },
							],
						},
						{
							label: 'On-Premise',
							collapsed: true,
							items: [
								{ label: 'Setup', slug: 'enterprise/on-premise/setup' },
								{ label: 'Local Transcription', slug: 'enterprise/on-premise/transcription' },
								{ label: 'Local Post-Processing', slug: 'enterprise/on-premise/post-processing' },
								{ label: 'Updates & Renewal', slug: 'enterprise/on-premise/renewal' },
							],
						},
						{
							label: 'Admin Portal',
							collapsed: true,
							items: [
								{ label: 'Overview', slug: 'enterprise/admin-portal/overview' },
								{ label: 'Users', slug: 'enterprise/admin-portal/users' },
								{ label: 'Global Dictionary', slug: 'enterprise/admin-portal/global-dictionary' },
							  { label: 'Global Styles', slug: 'enterprise/admin-portal/global-styles' },
								{ label: 'Transcription & AI Providers', slug: 'enterprise/admin-portal/transcription-providers' },
								{ label: 'Settings', slug: 'enterprise/admin-portal/settings' },
							],
						},
						{
							label: 'SSO',
							collapsed: true,
							items: [
								{ label: 'Overview', slug: 'enterprise/sso/overview' },
								{ label: 'Azure Entra ID', slug: 'enterprise/sso/azure-entra-id' },
								{ label: 'Keycloak', slug: 'enterprise/sso/keycloak' },
							],
						},
						{
							label: 'Deployment',
							collapsed: true,
							items: [
								{ label: 'Microsoft Intune', slug: 'enterprise/deployment/intune' },
							],
						},
					],
				},
			],
		}),
		sitemap(),
	],
});
