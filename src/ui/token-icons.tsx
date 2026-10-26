import React, { memo } from 'react';
import Svg, { Circle, Path, type SvgProps } from 'react-native-svg';
import { TOKEN_LOGOS } from './token-icon-assets.js';
import { getTokenIconId, type TokenIconIdentity } from './token-icon-registry.js';

export interface TokenIconProps extends Omit<SvgProps, 'width' | 'height'>, TokenIconIdentity {
  size?: number;
  /** Compatibility only. A symbol cannot identify a token or select a trusted logo. */
  symbol?: string;
  strokeWidth?: number;
}

/** Authentic fixed-color logos are bundled; rendering never contacts a logo server. */
export const TokenIcon = memo(function TokenIcon({ chainId, address, native, size = 32, symbol: _symbol, color: _color, fill: _fill, stroke: _stroke, strokeWidth: _strokeWidth, ...props }: TokenIconProps) {
  const iconId = getTokenIconId({ chainId, address, native });
  const Logo = iconId ? TOKEN_LOGOS[iconId] : undefined;
  if (Logo) return <Logo size={size} {...props} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none" accessibilityElementsHidden importantForAccessibility="no" {...props}>
      <Circle cx="16" cy="16" r="16" fill="#34415b" />
      <Circle cx="16" cy="16" r="8.5" stroke="#c2cbe0" strokeWidth="1.8" />
      <Path d="m16 11l5 5l-5 5l-5-5z" stroke="#c2cbe0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
});

/** Kept for existing UI imports; supply chainId and address/native to resolve a logo. */
export const AssetMark = TokenIcon;
export { getTokenIconId } from './token-icon-registry.js';
