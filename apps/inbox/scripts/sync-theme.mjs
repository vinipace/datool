import { readFileSync, writeFileSync } from 'node:fs';
const css = readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8');
const dark = css.match(/\.dark\s*\{([^}]+)\}/)?.[1];
if (!dark) throw new Error('Datool dark theme is missing');
const theme = css.match(/@theme\s*\{([^}]+)\}/)?.[1] ?? '';
const tokens = Object.fromEntries([...(theme + dark).matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2]]));
const channelTokens = Object.fromEntries(Object.keys(tokens).filter(token => token.startsWith('color-channel-')).map(token => [token.replace('color-', '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), token]));
const avatarTokens = Object.fromEntries(Object.keys(tokens).filter(token => token.startsWith('inbox-avatar-')).map(token => [token.replace('inbox-', '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), token]));
const brandTokens = Object.fromEntries(Object.keys(tokens).filter(token => token.startsWith('inbox-brand-')).map(token => [token.replace('inbox-', '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), token]));
const colors = Object.fromEntries(Object.entries({ ...channelTokens, ...avatarTokens, ...brandTokens, authButton:'inbox-auth-button', authOnButton:'inbox-auth-on-button', glassEdge:'inbox-glass-edge', glassTint:'inbox-glass-tint', glassSelected:'inbox-glass-selected', background:'inbox-background', surface:'inbox-surface', foreground:'inbox-foreground', muted:'inbox-muted', border:'inbox-border', primary:'inbox-accent', onPrimary:'inbox-on-accent', selection:'inbox-selection', selectionText:'inbox-selection-text', control:'inbox-control', outgoing:'inbox-outgoing', incoming:'inbox-incoming', messageMeta:'inbox-message-meta', header:'inbox-header', wallpaper:'inbox-wallpaper', error:'destructive', success:'success', warning:'warning' }).map(([name, token]) => {
  if (!/^#[a-f0-9]{6}([a-f0-9]{2})?$/i.test(tokens[token] ?? '')) throw new Error(`Expected a native-compatible hex token: ${token}`);
  return [name, tokens[token]];
}));
writeFileSync(new URL('../src/theme.generated.json', import.meta.url), JSON.stringify(colors, null, 2) + '\n');
