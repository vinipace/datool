# Channel logo artwork

Channel logos are bundled as vector paths in `src/components/channel-logo-paths.json` and rendered by `channel-logo.tsx`. They work without a network connection. Geometry is sourced from the following assets, not the application's outline icon set:

- Telegram: [official logo SVG](https://telegram.org/img/t_logo.svg), including its blue gradient and white paper plane. [Logo resources](https://telegram.org/tour/screenshots).
- WhatsApp: existing Simple Icons glyph, rendered white with padding on WhatsApp green.
- Instagram, Messenger and Slack: [Simple Icons 13.0.0](https://github.com/simple-icons/simple-icons/tree/13.0.0/icons), licensed [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/13.0.0/LICENSE.md). Slack's eight subpaths are grouped into the four original brand colors; their geometry is unchanged.

Messenger uses the blue identity described in [Meta's February 2025 brand update](https://www.meta.com/brand/resources/facebook/messenger-icon/). Instagram uses its white camera glyph on a gradient badge; Slack uses its multicolor mark on white. Brand colors are centralized under `--inbox-brand-*` in `app/globals.css`.

Logos identify conversation sources. Generic channels (web, email, API and helpdesk) use neutral symbols because they do not identify a specific app or provider.
