import React, { forwardRef, useId } from "react";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text,
} from "react-native-svg";
import type { SvgProps } from "react-native-svg";
import QRCode from "react-native-qrcode-svg";
import type { LanguageCode } from "../../i18n.js";
import { DreamKeyLogoMark } from "../DreamKeyLogo.js";

export interface InvitePosterProps {
  downloadUrl: string;
  language: LanguageCode;
  width: number;
  onLayout?: SvgProps['onLayout'];
}

function displayUrlLines(url: string): string[] {
  const label = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const shortened = label.length > 92 ? `${label.slice(0, 89)}…` : label;
  return shortened.match(/.{1,46}/g) ?? [];
}

/** The complete poster lives in one SVG so its ref exports the QR and artwork together. */
export const InvitePoster = forwardRef<Svg, InvitePosterProps>(function InvitePoster(
  { downloadUrl, language, width, onLayout },
  ref,
) {
  const zh = language === "zh";
  const url = downloadUrl.trim();
  const hasDownloadUrl = url.length > 0;
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const backgroundId = `invite-background-${id}`;
  const glowId = `invite-glow-${id}`;
  const clipId = `invite-clip-${id}`;
  const urlLines = displayUrlLines(url);
  const accessibleDescription = zh
    ? `DreamKey 邀请海报。你的密钥，你的资产。多链资产、本地密钥、DApp 探索。${hasDownloadUrl ? `扫描二维码下载，下载地址：${url}` : "下载地址即将上线。"}`
    : `DreamKey invitation poster. Your keys. Your assets. Multichain assets, local keys, and DApp exploration. ${hasDownloadUrl ? `Scan the QR code to download: ${url}` : "The download link is coming soon."}`;

  return (
    <Svg
      ref={ref}
      width={width}
      height={(width * 1120) / 720}
      viewBox="0 0 720 1120"
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibleDescription}
    >
      <Defs>
        <LinearGradient id={backgroundId} x1="0%" y1="0%" x2="90%" y2="100%">
          <Stop offset="0%" stopColor="#1c204b" />
          <Stop offset="48%" stopColor="#111a35" />
          <Stop offset="100%" stopColor="#0c1224" />
        </LinearGradient>
        <LinearGradient id={glowId} x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#a895ff" />
          <Stop offset="100%" stopColor="#57d9eb" />
        </LinearGradient>
        <ClipPath id={clipId}>
          <Rect width={720} height={1120} rx={36} />
        </ClipPath>
      </Defs>

      <G clipPath={`url(#${clipId})`}>
        <Rect width={720} height={1120} fill={`url(#${backgroundId})`} />
        <Circle cx={670} cy={192} r={251} fill="#7b61ff" opacity={0.08} />
        <Circle cx={670} cy={192} r={190} fill="none" stroke="#a895ff" strokeWidth={1.5} opacity={0.12} />
        <Circle cx={670} cy={192} r={130} fill="none" stroke="#a895ff" strokeWidth={1.5} opacity={0.12} />
        <Path d="M511 178 673 340 511 526 349 340Z" fill={`url(#${glowId})`} opacity={0.055} />
        <Circle cx={619} cy={412} r={5} fill="#6ddff6" opacity={0.7} />
        <Circle cx={458} cy={222} r={3} fill="#b6a7ff" opacity={0.65} />
        <Path d="M637 263h16m-8-8v16" stroke="#b6a7ff" strokeWidth={2} opacity={0.65} />

        <Rect x={55} y={63} width={108} height={108} rx={31} fill="#a895ff" opacity={0.35} />
        <DreamKeyLogoMark x={56} y={64} size={106} />
        <Text x={188} y={112} fill="#f7f9ff" fontSize={47} fontWeight="700">DreamKey</Text>
        <Text x={190} y={151} fill="#b7b9d7" fontSize={22} letterSpacing={1.2}>YOUR WEB3 COMPANION</Text>

        <Rect x={56} y={218} width={45} height={5} rx={2.5} fill="#a895ff" />
        <Text x={52} y={308} fill="#f7f9ff" fontSize={zh ? 70 : 74} fontWeight="700">
          {zh ? "你的密钥，" : "Your keys."}
        </Text>
        <Text x={52} y={396} fill={`url(#${glowId})`} fontSize={zh ? 70 : 74} fontWeight="700">
          {zh ? "你的资产。" : "Your assets."}
        </Text>
        <Text x={56} y={444} fill="#b7bfd6" fontSize={zh ? 26 : 24}>
          {zh ? "邀请好友，一起探索 Web3" : "Invite a friend. Explore Web3 together."}
        </Text>

        <G transform="translate(56 490)">
          <Rect width={192} height={116} rx={22} fill="#202b49" stroke="#35405f" />
          <G transform="translate(78 17)" fill="none" stroke="#a895ff" strokeWidth={2.5} strokeLinejoin="round">
            <Path d="m18 1 17 10-17 10L1 11Z" fill="#a895ff" fillOpacity={0.16} />
            <Path d="m1 19 17 10 17-10M1 27l17 10 17-10" />
          </G>
          <Text x={96} y={89} textAnchor="middle" fill="#f7f9ff" fontSize={zh ? 24 : 21} fontWeight="600">
            {zh ? "多链资产" : "Multichain Assets"}
          </Text>
        </G>
        <G transform="translate(264 490)">
          <Rect width={192} height={116} rx={22} fill="#202b49" stroke="#35405f" />
          <G transform="translate(78 17)" fill="none" stroke="#a895ff" strokeWidth={2.5} strokeLinejoin="round">
            <Path d="M18 1 34 7v12c0 9-8 15-16 19C10 34 2 28 2 19V7Z" fill="#a895ff" fillOpacity={0.16} />
            <Path d="m10 19 5 5 11-12" strokeLinecap="round" />
          </G>
          <Text x={96} y={89} textAnchor="middle" fill="#f7f9ff" fontSize={zh ? 24 : 21} fontWeight="600">
            {zh ? "密钥自持" : "Your Own Keys"}
          </Text>
        </G>
        <G transform="translate(472 490)">
          <Rect width={192} height={116} rx={22} fill="#202b49" stroke="#35405f" />
          <G transform="translate(78 17)" fill="none" stroke="#a895ff" strokeWidth={2.5} strokeLinejoin="round">
            <Circle cx={18} cy={19} r={17} fill="#a895ff" fillOpacity={0.16} />
            <Path d="m25 12-4 10-10 4 4-10Z" fill="#a895ff" fillOpacity={0.4} />
          </G>
          <Text x={96} y={89} textAnchor="middle" fill="#f7f9ff" fontSize={zh ? 24 : 21} fontWeight="600">
            {zh ? "探索 DApp" : "Explore DApps"}
          </Text>
        </G>

        <Rect x={56} y={656} width={608} height={304} rx={28} fill="#f7f8ff" />
        {hasDownloadUrl ? (
          <G transform="translate(80 696)">
            <QRCode value={url} size={224} quietZone={12} color="#111a35" backgroundColor="#f7f8ff" ecl="M" />
          </G>
        ) : (
          <G transform="translate(80 696)">
            <Rect width={224} height={224} rx={18} fill="#e9e8f5" />
            <G transform="translate(77 77)" fill="none" stroke="#7b61ff" strokeWidth={6} strokeLinecap="round">
              <Path d="m29 22 12-12a17 17 0 0 1 24 24L53 46M41 48 29 60A17 17 0 0 1 5 36l12-12M24 46l22-22" />
            </G>
          </G>
        )}
        <Text x={334} y={746} fill="#18203b" fontSize={zh ? 36 : 30} fontWeight="700">
          {hasDownloadUrl ? (zh ? "扫码下载" : "Scan to Download") : (zh ? "即将上线" : "Coming Soon")}
        </Text>
        <Text x={334} y={793} fill="#53607d" fontSize={zh ? 25 : 23}>
          {zh ? "DreamKey 钱包" : "DreamKey Wallet"}
        </Text>
        <Text x={334} y={832} fill="#53607d" fontSize={zh ? 23 : 21}>
          {hasDownloadUrl ? (zh ? "开启你的 Web3 旅程" : "Start your Web3 journey.") : (zh ? "下载地址即将公布" : "Download link coming soon.")}
        </Text>
        <Rect x={334} y={864} width={zh ? 235 : 252} height={42} rx={21} fill="#ebe6ff" />
        <Text x={zh ? 451.5 : 460} y={892} textAnchor="middle" fill="#6d50d3" fontSize={zh ? 20 : 18} fontWeight="600">
          {zh ? "和好友一起探索" : "Explore with Friends"}
        </Text>

        {hasDownloadUrl ? urlLines.map((line, index) => (
          <Text key={index} x={360} y={1001 + index * 27} textAnchor="middle" fill="#a8b1c7" fontSize={21}>
            {line}
          </Text>
        )) : (
          <Text x={360} y={1006} textAnchor="middle" fill="#a8b1c7" fontSize={23}>
            {zh ? "把 DreamKey 分享给你的朋友" : "Share DreamKey with your friends"}
          </Text>
        )}
        <Path d="M298 1069h31m62 0h31" stroke="#444667" strokeWidth={1.5} />
        <Path d="m360 1058 11 11-11 13-11-13Z" fill={`url(#${glowId})`} />
      </G>
    </Svg>
  );
});
