// Development-only conversion of a fixed Iconify icon selection into native SVG.
// No arbitrary SVG parsing or network requests run in the wallet app.
const fs = require('node:fs');
const path = require('node:path');

const source = JSON.parse(fs.readFileSync(path.join(__dirname, 'ph-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const controls = JSON.parse(fs.readFileSync(path.join(__dirname, 'ph-controls-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const crypto = JSON.parse(fs.readFileSync(path.join(__dirname, 'cryptocurrency-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const coloredCrypto = JSON.parse(fs.readFileSync(path.join(__dirname, 'cryptocurrency-color-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const branded = JSON.parse(fs.readFileSync(path.join(__dirname, 'token-branded-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const networks = JSON.parse(fs.readFileSync(path.join(__dirname, 'network-branded-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const officialTokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'official-token-source.json'), 'utf8').replace(/^\uFEFF/, ''));
const selected = {
  ArrowDownLeft: 'arrow-down-left', ArrowUpRight: 'arrow-up-right',
  ChevronDown: 'caret-down', ChevronRight: 'caret-right', ChevronLeft: 'caret-left',
  Compass: 'compass-duotone', LockKeyhole: 'lock-key-duotone', Settings: 'gear-six-duotone',
  Wallet: 'wallet-duotone', ArrowLeft: 'arrow-left', ArrowRight: 'arrow-right', RefreshCw: 'arrow-clockwise', Globe: 'globe-duotone',
  Globe2: 'globe-hemisphere-west-duotone', Star: 'star-duotone', Bookmark: 'bookmark-simple-duotone',
  Clock3: 'clock-duotone', Search: 'magnifying-glass-duotone', ShieldCheck: 'shield-check-duotone',
  Trash2: 'trash-duotone', Copy: 'copy-duotone', Share2: 'share-network-duotone', Check: 'check',
  Coins: 'coins-duotone', Fuel: 'gas-pump-duotone', CircleAlert: 'warning-circle-duotone',
  Plus: 'plus', X: 'x', KeyRound: 'key-duotone', Eye: 'eye-duotone',
  EyeOff: 'eye-slash-duotone', FileKey: 'file-lock-duotone', UserRound: 'user-circle-duotone',
  Fingerprint: 'fingerprint-duotone', Activity: 'arrows-down-up-duotone',
  ArrowLeftRight: 'arrows-left-right-duotone', Signature: 'signature-duotone', Link: 'link-duotone',
};
const properties = { 'fill-rule': 'fillRule', 'fill-opacity': 'fillOpacity', 'clip-rule': 'clipRule', 'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity' };
const numericProperties = new Set(['opacity', 'fill-opacity', 'cx', 'cy', 'r', 'fx', 'fy', 'x1', 'x2', 'y1', 'y2', 'offset', 'stop-opacity']);
function nativeBody(body, highlight = false) {
  return body.replace(/<[^>]+>/g, (tag) => {
    const element = /^<(\/)?(g|path|circle|defs|linearGradient|radialGradient|stop)\b([^>]*)>$/s.exec(tag);
    if (!element) throw new Error(`Unsupported SVG tag in pinned icon: ${tag}`);
    const [, closing, name, attrs] = element;
    const component = { g: 'G', path: 'Path', circle: 'Circle', defs: 'Defs', linearGradient: 'LinearGradient', radialGradient: 'RadialGradient', stop: 'Stop' }[name];
    if (closing) return `</${component}>`;
    const attributes = [];
    for (const attr of attrs.matchAll(/([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g)) {
      const [, key, value] = attr;
      if (!['fill', 'd', 'opacity', 'fill-rule', 'fill-opacity', 'clip-rule', 'cx', 'cy', 'r', 'fx', 'fy', 'id', 'x1', 'x2', 'y1', 'y2', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity'].includes(key)) throw new Error(`Unsupported SVG attribute: ${key}`);
      const prop = properties[key] || key;
      // react-native-svg requires an integer part for gradient stop strings (e.g. 0.88).
      const nativeValue = numericProperties.has(key) ? value.replace(/^([+-]?)\.(?=\d)/, (_, sign) => `${sign}0.`) : value;
      attributes.push(value === 'currentColor' ? `${prop}={color}` : highlight && key === 'opacity' && value === '.2' ? 'opacity={highlighted ? 1 : 0.2}' : `${prop}=${JSON.stringify(nativeValue)}`);
    }
    return `<${component}${attributes.length ? ' ' + attributes.join(' ') : ''}${attrs.trimEnd().endsWith('/') ? ' /' : ''}>`;
  });
}
let output = `// Generated from pinned Iconify assets by icons/generate.cjs. See docs/icon-attribution.md.\nimport React, { memo } from 'react';\nimport Svg, { G, Path, type SvgProps } from 'react-native-svg';\nimport { NETWORK_LOGOS } from './token-icon-assets.js';\n\nexport interface IconProps extends Omit<SvgProps, 'width' | 'height'> {\n  size?: number;\n  /** Accepted for the old icon call sites; Phosphor supplies its own optical weight. */\n  strokeWidth?: number;\n}\n\n`;
for (const [name, key] of Object.entries(selected)) {
  const icon = controls.icons[key] || source.icons[key];
  if (!icon) throw new Error(`Missing selected Iconify icon: ${key}`);
  const highlight = name === 'Star';
  output += `export const ${name} = memo(function ${name}({ size = 24, color = '#f7f9ff', strokeWidth: _strokeWidth, fill: ${highlight ? 'fill' : '_fill'}, ...props }: IconProps) {\n`;
  if (highlight) output += `  const highlighted = Boolean(fill && fill !== 'none');\n`;
  output += `  return <Svg width={size} height={size} viewBox="0 0 ${icon.width || source.width} ${icon.height || source.height}" fill="none" accessibilityElementsHidden importantForAccessibility="no" {...props}>${nativeBody(icon.body, highlight)}</Svg>;\n});\n\n`;
}
for (const [name, key, defaultColor] of [['Bnb', 'bnb', '#f3ba2f'], ['Ethereum', 'eth', '#8797ec']]) {
  const icon = crypto.icons[key];
  output += `export const ${name} = memo(function ${name}({ size = 24, color = '${defaultColor}', strokeWidth: _strokeWidth, fill: _fill, ...props }: IconProps) {\n  return <Svg width={size} height={size} viewBox="0 0 ${icon.width || crypto.width} ${icon.height || crypto.height}" fill="none" accessibilityElementsHidden importantForAccessibility="no" {...props}>${nativeBody(icon.body)}</Svg>;\n});\n\n`;
}
output += `export { AssetMark, TokenIcon, getTokenIconId, type TokenIconProps } from './token-icons.js';\n\n/** Network branding preserves its original colors; native assets use TokenIcon. */\nexport function NetworkMark({ chainId, color: _color, fill: _fill, stroke: _stroke, strokeWidth: _strokeWidth, size = 24, ...props }: IconProps & { chainId: number }) {\n  const Logo = NETWORK_LOGOS[chainId];\n  if (Logo) return <Logo size={size} {...props} />;\n  return <Globe size={size} color="#b6a7ff" {...props} />;\n}\n`;
fs.writeFileSync(path.join(__dirname, '..', 'icons.tsx'), output);

const logoIds = ['bnb', 'eth', 'usdt', 'usdt0', 'usdc', 'usdc-e', 'dai', 'wbtc', 'btc', 'uni', 'link', 'cake', 'pol', 'arb', 'cbeth', 'aero'];
const logoName = (key) => `${key.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}Logo`;
let tokenOutput = `// Generated fixed-color logos by icons/generate.cjs. See docs/icon-attribution.md.\nimport React, { memo } from 'react';\nimport Svg, { Circle, Defs, G, LinearGradient, RadialGradient, Path, Stop, type SvgProps } from 'react-native-svg';\nimport type { TokenIconId } from './token-icon-registry.js';\n\ninterface LogoProps extends Omit<SvgProps, 'width' | 'height'> { size?: number }\n\n`;
for (const key of logoIds) {
  const collection = key === 'arb' ? networks : key === 'usdt0' ? officialTokens : ['cake', 'pol', 'cbeth', 'aero'].includes(key) ? branded : coloredCrypto;
  const icon = collection.icons[key === 'usdc-e' ? 'usdc' : key === 'arb' ? 'arbitrum-one' : key];
  if (!icon) throw new Error(`Missing selected token logo: ${key}`);
  if (icon.body.includes('currentColor')) throw new Error(`Token logo must preserve original colors: ${key}`);
  const name = logoName(key);
  // Wallet bridge badge differentiates USDC.e from issuer-native USDC.
  const bridgeBadge = key === 'usdc-e' ? '<Circle cx="26" cy="26" r="5.5" fill="#1f2a44" stroke="#fff" strokeWidth="1" /><Path d="M25.1 24h-1a1.6 1.6 0 0 0 0 3.2h1m1.8-3.2h1a1.6 1.6 0 0 1 0 3.2h-1M24.6 25.6h2.8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />' : '';
  tokenOutput += `const ${name} = memo(function ${name}({ size = 32, ...props }: LogoProps) {\n  return <Svg width={size} height={size} viewBox="0 0 ${icon.width || collection.width} ${icon.height || collection.height}" fill="none" accessibilityElementsHidden importantForAccessibility="no" {...props}>${nativeBody(icon.body)}${bridgeBadge}</Svg>;\n});\n\n`;
}
tokenOutput += `export const TOKEN_LOGOS: Readonly<Record<TokenIconId, React.ComponentType<LogoProps>>> = {\n`;
for (const key of logoIds) tokenOutput += `  ${JSON.stringify(key)}: ${logoName(key)},\n`;
tokenOutput += `};\n`;
for (const key of ['arbitrum-one', 'polygon', 'base']) {
  const icon = networks.icons[key];
  if (!icon || icon.body.includes('currentColor')) throw new Error(`Missing or non-branded network logo: ${key}`);
  const name = logoName(key);
  tokenOutput += `\nconst ${name} = memo(function ${name}({ size = 24, ...props }: LogoProps) {\n  return <Svg width={size} height={size} viewBox="0 0 ${icon.width || networks.width} ${icon.height || networks.height}" fill="none" accessibilityElementsHidden importantForAccessibility="no" {...props}>${nativeBody(icon.body)}</Svg>;\n});\n`;
}
tokenOutput += `\nexport const NETWORK_LOGOS: Readonly<Partial<Record<number, React.ComponentType<LogoProps>>>> = {\n  1: EthLogo,\n  56: BnbLogo,\n  42161: ArbitrumOneLogo,\n  137: PolygonLogo,\n  8453: BaseLogo,\n};\n`;
fs.writeFileSync(path.join(__dirname, '..', 'token-icon-assets.tsx'), tokenOutput);
process.stdout.write(`Generated ${Object.keys(selected).length + 2} interface icons, 5 network marks and ${logoIds.length} fixed-color token logos.\n`);
