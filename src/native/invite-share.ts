import { NativeModules } from 'react-native';

export interface InviteImageShareOptions {
  /** Raw PNG data from SVG.toDataURL(), or a PNG data URI. */
  pngBase64: string;
  /** Invitation copy including the public download link. */
  message: string;
  title?: string;
}

interface NativeInviteShare {
  shareImage(pngBase64: string, message: string, title: string): Promise<void>;
}

const MAX_BASE64_LENGTH = 16 * 1024 * 1024;

/** Opens the system share sheet. Dismissing it is a successful no-op. */
export async function shareInviteImage(options: InviteImageShareOptions): Promise<void> {
  const pngBase64 = options.pngBase64.replace(/^data:image\/png;base64,/i, '').trim();
  if (!pngBase64 || pngBase64.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(pngBase64)) {
    throw new Error('Invalid invitation image');
  }
  const nativeShare = NativeModules.DreamKeyInviteShare as NativeInviteShare | undefined;
  if (!nativeShare?.shareImage) {
    throw new Error('Image sharing is unavailable in this app build');
  }
  await nativeShare.shareImage(pngBase64, options.message, options.title ?? 'DreamKey');
}
