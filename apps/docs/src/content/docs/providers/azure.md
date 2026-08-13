---
title: "Azure Speech and Azure OpenAI"
description: "Distinguish Azure Speech transcription fields from Azure OpenAI generation fields and tests."
sidebar:
  order: 7
---

The **Azure** provider changes meaning with the task. In **AI transcription**, it uses Azure AI Speech. In **AI post processing** and **Assistant mode**, it uses Azure OpenAI. A record saved for one side does not automatically contain the connection data needed by the other.

## Azure AI Speech

The transcription form requires:

- **Azure Region**: the Speech resource region, such as `eastus`—not a full URL.
- **Subscription key**: the key belonging to that Speech resource.

Normal recording starts an Azure Speech continuous recognizer and streams microphone samples into it. The app gathers recognized phrases and returns the assembled text at finalization. It deliberately reports no real-time-output support, so Azure segments are not inserted while you are still speaking. Dictionary context is split into phrases and supplied as phrase-list hints.

A selected locale is mapped to an Azure locale; unsupported or empty values fall back to `en-US`. The separate stored-audio path uses 60-second chunks with five seconds of overlap and up to three requests per batch.

The current Speech **Test** uses an empty audio buffer and treats errors as acceptable unless their text specifically mentions authentication or subscription. That is not a dependable end-to-end credential check. Confirm with a short real recording and inspect its History result.

## Azure OpenAI

Generation forms require:

- **Resource endpoint**: the endpoint shown for the Azure OpenAI resource.
- **API key**: a key for that resource.
- **Model**: in practice, the Azure deployment name passed in the request's model field.

mausVoice uses API version `2024-10-21`. The default generation value is `gpt-4o-mini`, while the picker also suggests common names such as `gpt-4o`, `gpt-4`, and `gpt-35-turbo`. Your deployment name can differ from its underlying model name; type the actual deployment name.

The Azure OpenAI **Test** sends a tiny chat request using the literal `gpt-4o-mini`. It can fail when your valid resource has no deployment with that name, and success does not validate a different deployment selected for the task. Post-processing and Assistant use the selected deployment independently.

Do not put a portal page URL or a Speech endpoint into the Azure OpenAI endpoint field. If a request fails, compare the resource type, region/endpoint, deployment spelling, API access, and task in which that record was created.
