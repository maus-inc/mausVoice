---
title: "Interface languages"
description: "Reference the translation catalogs, locale matching, fallback behavior, and separation from spoken language."
sidebar:
  order: 5
---

The desktop frontend ships ten `react-intl` catalogs:

| Code    | Interface locale     |
| ------- | -------------------- |
| `en`    | English              |
| `es`    | Spanish              |
| `fr`    | French               |
| `de`    | German               |
| `pt`    | Portuguese           |
| `pt-BR` | Brazilian Portuguese |
| `it`    | Italian              |
| `zh-TW` | Traditional Chinese  |
| `zh-CN` | Simplified Chinese   |
| `ko`    | Korean               |

At frontend startup, locale detection checks the browser/webview language candidates. It first matches a complete supported tag, converts underscores to hyphens, then falls back to the language portion. An unsupported locale falls back to the manifest default, English. This means `pt-BR` can retain its regional catalog while another Portuguese region resolves to `pt`.

These catalogs do not define transcription coverage. **Settings → Processing → Dictation language** stores the user's primary spoken language and affects provider/local decoding and prompts; it is not currently wired to recreate the top-level interface `IntlProvider`. Changing that setting should therefore not be documented as a live interface-language switch.

For contributors, author visible copy with `FormattedMessage`/`useIntl` and a specific English `defaultMessage`, then run:

```bash
pnpm --filter desktop i18n
```

That combines extraction and synchronization. Review the resulting catalog diff. Automation can add keys, but cannot guarantee idiomatic translations or that a new sentence fits every compact control. Keep locale codes aligned across `config.ts`, `manifest.json`, imports, and catalog files.
