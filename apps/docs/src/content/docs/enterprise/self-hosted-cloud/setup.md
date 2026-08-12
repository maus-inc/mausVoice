---
title: Self-Hosted Cloud Setup
description: Deploy mausVoice Enterprise on your own cloud infrastructure.
---

Self-Hosted Cloud gives you full control over your mausVoice Enterprise deployment by running it on your own cloud infrastructure. You provision and manage the servers, database, and networking within your cloud account.

## Prerequisites

- A cloud account with your provider of choice (AWS, GCP, Azure, or another provider).
- A mausVoice Enterprise license key. Contact [enterprise@mausvoice.com](mailto:enterprise@mausvoice.com) if you don't have one yet.

## 1. Obtain a License Key

Contact [enterprise@mausvoice.com](mailto:enterprise@mausvoice.com) to obtain your license key. You'll need this to configure the gateway service.

## 2. Deploy to Your Cloud Provider

Follow the guide for your cloud provider:

- [AWS](../aws/)
- [GCP](../gcp/)
- [Azure](../azure/)
Each guide walks you through provisioning the necessary resources and deploying the mausVoice services.

### Invite Gateway URL

The admin portal container requires the `MAUSVOICE_GATEWAY_URL` environment variable to be set to the public URL of your gateway service. Without this, the admin portal won't be able to communicate with the gateway and core features like user invites won't work. Each cloud provider guide covers how to set this, but be sure to use the actual URL of your deployed gateway — not `localhost`.

## 3. Configure the Desktop App

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

Replace `your-gateway-url` with the public URL of your deployed gateway service.

## 4. Create the First Admin

Open your admin portal URL in your browser. The first person to sign up becomes the organization admin. Use a strong password and save it somewhere safe — there is no password recovery for the initial admin account.

From here you can manage users, configure settings, and control how mausVoice operates across your organization.
