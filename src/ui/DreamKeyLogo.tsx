import React, { useId } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

/** Shared artwork for screens and SVG poster exports; no bitmap resource to load. */
export function DreamKeyLogoMark({ x = 0, y = 0, size = 1024 }: { x?: number; y?: number; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const backgroundId = `dreamkey-logo-background-${id}`;
  const glowId = `dreamkey-logo-glow-${id}`;

  return (
    <G transform={`translate(${x} ${y}) scale(${size / 1024})`}>
      <Defs>
        <LinearGradient id={backgroundId} x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#090d23" />
          <Stop offset="100%" stopColor="#16193f" />
        </LinearGradient>
        <RadialGradient id={glowId} cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0%" stopColor="#619cff" stopOpacity={0.38} />
          <Stop offset="100%" stopColor="#619cff" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={1024} height={1024} rx={290} fill={`url(#${backgroundId})`} />
      <Rect x={48} y={48} width={928} height={928} rx={210} fill="#0f193e" stroke="#36477d" strokeWidth={8} />
      <Circle cx={512} cy={512} r={370} fill={`url(#${glowId})`} />
      {/* Coordinates and facet colors match scripts/generate-dreamkey-icons.py. */}
      <Path d="M512 206 836 492 512 798 188 492Z" fill="#000000" opacity={0.28} />
      <Path d="M512 196 512 492 198 492Z" fill="#51e0ff" />
      <Path d="M512 196 826 492 512 492Z" fill="#976fff" />
      <Path d="M198 492 512 492 512 788Z" fill="#1faadb" />
      <Path d="M512 492 826 492 512 788Z" fill="#6841e0" />
      <Path d="M512 196 826 492" fill="none" stroke="#d1dcff" strokeOpacity={0.9} strokeWidth={5} />
      <Path d="M512 196 198 492" fill="none" stroke="#b5f7ff" strokeOpacity={0.78} strokeWidth={5} />
      <Circle cx={512} cy={457} r={64} fill="#08102a" />
      <Path d="M475 482H549L582 650H442Z" fill="#08102a" />
      <Circle cx={512} cy={457} r={45} fill="#f5faff" />
      <Path d="M487 478H537L558 604H466Z" fill="#f5faff" />
      <Path d="M747 278 761 316 799 332 761 348 747 388 733 348 695 332 733 316Z" fill="#ffd366" />
    </G>
  );
}

export function DreamKeyLogo({ size, style }: { size: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      style={[styles.logo, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="DreamKey"
      accessibilityIgnoresInvertColors
    >
      <DreamKeyLogoMark />
    </Svg>
  );
}

const styles = StyleSheet.create({ logo: { flexShrink: 0 } });
