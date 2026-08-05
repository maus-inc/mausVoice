---
title: Managed Cloud Setup
description: Get started with a fully managed mausVoice Enterprise deployment.
---

With Managed Cloud, mausVoice handles the infrastructure so you can focus on your organization. We provision a dedicated server exclusively for your organization, set it up, and manage it on an ongoing basis. All data is private to your organization, and you choose which AI and transcription providers to use.

The server code is fully open source, giving you complete visibility into what runs on your behalf.

## What's Included

- A dedicated mausVoice gateway server provisioned and managed by the mausVoice team.
- An admin portal specific to your organization for managing users, providers, and settings.
- Ongoing server maintenance, updates, and monitoring.
- Support from the mausVoice team for configuration and troubleshooting.

## 1. Onboarding

Contact [enterprise@mausvoice.com](mailto:enterprise@mausvoice.com) to get started. We'll work with you to provision your dedicated server and provide you with your gateway URL and admin portal URL.

## 2. Configure the Desktop App

Each mausVoice desktop client needs an `enterprise.json` file placed in the app config directory. If you're distributing mausVoice with a tool like Microsoft Intune, this file can be placed automatically as part of the deployment.

If you're doing this manually, place the file at the following path for each platform:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.mausinc.desktop/enterprise.json` |
| Linux | `~/.config/com.mausinc.desktop/enterprise.json` |
| Windows | `C:\Users\<User>\AppData\Roaming\com.mausinc.desktop\enterprise.json` |

The file should contain:

```json
{
  "gatewayUrl": "https://your-gateway-url"
}
```

Replace `your-gateway-url` with the gateway URL provided during onboarding.

## 3. Create the First Admin

Open the admin portal URL provided during onboarding in your browser. The first person to sign up becomes the organization admin. Use a strong password and store it somewhere safe. If you lose access, contact [enterprise@mausvoice.com](mailto:enterprise@mausvoice.com) and we can recover it after a verification process.

From here you can manage users, configure settings, and control how mausVoice operates across your organization.
