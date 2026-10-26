import React from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowUpRight, Star } from "../icons.js";
import { DappBrowserCloseButton, DappBrowserToolbar } from "../DappBrowserToolbar.js";
import { DappFavicon } from "../../dapp/DappFavicon.js";
import { DappBrowser } from "../../dapp/DappBrowser.js";
import type { DappBrowserRef, DappNavigationState, DappPageMetadata, ProviderRequestContext } from "../../dapp/types.js";
import type { RequestArguments } from "../../provider/types.js";
import { colors, styles } from "../appStyles.js";

export interface DappBrowserRouteViewProps {
  browserRef: React.RefObject<DappBrowserRef>;
  activeUrl: string;
  pageUrl: string;
  displayedAddress: string;
  urlInput: string;
  editingAddress: boolean;
  pageFaviconUrl?: string;
  favorites: string[];
  language: "zh" | "en";
  browserNavigation: DappNavigationState;
  t: (key: any, params?: any) => string;
  addressInputRef: React.RefObject<TextInput>;
  onUrlChange: (value: string) => void;
  onNavigate: () => void;
  onEditUrl: () => void;
  onBlurUrl: () => void;
  onClose: () => void;
  onToggleFavorite: () => void;
  onProviderRequest: (request: RequestArguments, context: ProviderRequestContext) => Promise<unknown>;
  onPageLoaded: (url: string) => void;
  onPageMetadata: (metadata: DappPageMetadata) => void;
  onNavigationStateChange: (state: DappNavigationState) => void;
}

export function DappBrowserRouteView({
  browserRef,
  activeUrl,
  pageUrl,
  displayedAddress,
  urlInput,
  editingAddress,
  pageFaviconUrl,
  favorites,
  language,
  browserNavigation,
  t,
  addressInputRef,
  onUrlChange,
  onNavigate,
  onEditUrl,
  onBlurUrl,
  onClose,
  onToggleFavorite,
  onProviderRequest,
  onPageLoaded,
  onPageMetadata,
  onNavigationStateChange,
}: DappBrowserRouteViewProps) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.browserBar}>
        <DappBrowserCloseButton onClose={onClose} />
        <View style={styles.browserAddressBar}>
          <DappFavicon pageUrl={pageUrl || activeUrl} faviconUrl={pageFaviconUrl} size={16} />
          <TextInput
            ref={addressInputRef}
            selectTextOnFocus
            accessibilityLabel={t("dappUrlPlaceholder")}
            value={editingAddress ? urlInput : displayedAddress}
            onChangeText={onUrlChange}
            onFocus={onEditUrl}
            onBlur={onBlurUrl}
            onSubmitEditing={onNavigate}
            style={styles.browserAddressInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
          />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t("go")} style={styles.browserIconButton} onPress={onNavigate}>
          <ArrowUpRight size={20} color={colors.accentBright} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("favorites")} accessibilityState={{ selected: favorites.includes(pageUrl) }} style={styles.browserIconButton} onPress={onToggleFavorite}>
          <Star size={20} color={colors.accentBright} fill={favorites.includes(pageUrl) ? colors.accentBright : "none"} />
        </Pressable>
      </View>
      <DappBrowser
        ref={browserRef}
        initialUrl={activeUrl}
        language={language}
        onBack={onClose}
        onEditUrl={onEditUrl}
        onProviderRequest={onProviderRequest}
        onPageLoaded={onPageLoaded}
        onPageMetadata={onPageMetadata}
        onNavigationStateChange={onNavigationStateChange}
        onNavigationBlocked={() => Alert.alert(t("navigationBlocked"), t("invalidDappUrl"))}
        allowedHosts={undefined}
        allowHttp={false}
        style={styles.flex}
      />
      <DappBrowserToolbar navigation={browserNavigation} onGoBack={() => browserRef.current?.goBack()} onGoForward={() => browserRef.current?.goForward()} onReload={() => browserRef.current?.reload()} />
    </SafeAreaView>
  );
}
