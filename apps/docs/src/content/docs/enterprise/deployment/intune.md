---
title: Microsoft Intune
description: Deploy mausVoice to Windows devices using Microsoft Intune.
---

This guide walks you through deploying mausVoice to Windows devices in your organization using Microsoft Intune. The deployment consists of two parts: the mausVoice app itself and a configuration script that connects it to your enterprise gateway.

## Prerequisites

- Microsoft Intune admin access
- [Microsoft Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool) installed
- A configured mausVoice Enterprise gateway (see [On-Premise Setup](../../on-premise/setup/) or your cloud deployment)

## Part 1: Deploy the mausVoice App

### 1. Download the Latest MSI

Download the latest mausVoice Windows MSI from the [GitHub releases page](https://github.com/mausvoice/mausvoice/releases). Look for a file named `mausVoice_x.x.x_x64_en-US.msi`.

Create a folder for your Intune package:

```
C:\IntunePackages\mausVoice\
```

Place the downloaded MSI in this folder.

### 2. Create the .intunewin Package

Use the Microsoft Win32 Content Prep Tool to package the MSI:

```cmd
IntuneWinAppUtil.exe -c "C:\IntunePackages\mausVoice" -s "mausVoice_x.x.x_x64_en-US.msi" -o "C:\IntunePackages\Output"
```

This creates `mausVoice_x.x.x_x64_en-US.intunewin` in the output folder.

### 3. Add the App in Intune

1. Sign in to the [Microsoft Intune admin center](https://intune.microsoft.com)
2. Navigate to **Apps** > **All apps** > **Add**
3. Select **Windows app (Win32)** as the app type
4. Click **Select** and upload your `.intunewin` file

### 4. Configure the App

Complete the app wizard using the default settings. Fill in basic app information (name, description, publisher) as needed.

### 5. Assign the App

1. Go to the **Assignments** tab
2. Under **Required**, click **Add group** and select the groups that should receive mausVoice
3. Click **Next** and then **Create**

## Part 2: Deploy the Enterprise Configuration

Use Intune's Platform Scripts feature to deploy the enterprise configuration to each device.

### 1. Create the Configuration Script

Create a PowerShell script named `Configure-mausVoice.ps1`:

```powershell
$enterpriseJson = @'
{
  "gatewayUrl": "http://your-gateway-host:4630"
}
'@

$basePath = Join-Path $env:APPDATA "com.mausinc.desktop"
$filePath = Join-Path $basePath "enterprise.json"

if (!(Test-Path $basePath)) {
    New-Item -ItemType Directory -Path $basePath -Force | Out-Null
}

Set-Content -Path $filePath -Value $enterpriseJson -Encoding UTF8
```

Replace `your-gateway-host:4630` with the actual hostname and port of your mausVoice Enterprise gateway.

### 2. Add the Script in Intune

1. In the Intune admin center, navigate to **Devices** > **Scripts and remediations** > **Platform scripts**
2. Click **Create**
3. Enter a name (e.g., "Configure mausVoice Enterprise") and click **Next**
4. Upload your `Configure-mausVoice.ps1` script

### 3. Configure Script Settings

Set **Enforce script signature check** to **No**. Leave the other settings at their defaults.

### 4. Assign the Script

1. Go to the **Assignments** tab
2. Select the same groups that receive the mausVoice app
3. Click **Next** and then **Create**

## Verification

After deployment, open mausVoice and check that your company name appears under the username. If it says "community" instead, the enterprise configuration was not applied correctly.
