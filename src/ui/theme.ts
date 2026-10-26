import type { ColorValue, TextStyle, ViewStyle } from 'react-native';

export const walletColors = {
  background: '#0c1224',
  surface: '#19233d',
  surfaceMuted: '#202d4d',
  ink: '#f7f9ff',
  textSecondary: '#a8b1c7',
  textTertiary: '#7c8aa7',
  border: '#2d3a5b',
  primary: '#7b61ff',
  primaryPressed: '#6950df',
  primarySoft: '#2a2450',
  success: '#49d89a',
  successSoft: '#123b33',
  warning: '#e5be6c',
  warningSoft: '#352b20',
  danger: '#ff7187',
  dangerSoft: '#3b2231',
  overlay: 'rgba(13, 16, 28, 0.48)',
  white: '#FFFFFF',
  black: '#000000',
} as const;

export const walletSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const walletRadii = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const walletTypography = {
  title: { fontSize: 27, lineHeight: 34, fontWeight: '700' } satisfies TextStyle,
  heading: { fontSize: 21, lineHeight: 28, fontWeight: '700' } satisfies TextStyle,
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' } satisfies TextStyle,
  bodyMedium: { fontSize: 15, lineHeight: 21, fontWeight: '600' } satisfies TextStyle,
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' } satisfies TextStyle,
  mono: { fontSize: 13, lineHeight: 18, fontFamily: 'monospace' } satisfies TextStyle,
} as const;

export type WalletSurfaceStyle = ViewStyle & { backgroundColor?: ColorValue };
