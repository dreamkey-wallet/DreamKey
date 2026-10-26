import React from "react";
import {
  NavigationContainer,
  useNavigationContainerRef,
  type Theme,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
} from "@react-navigation/native-stack";
import type { RootStackParamList, ScreenProps } from "./types.js";
import { colors } from "../ui/appStyles.js";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navigationTheme: Theme = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.background,
    card: colors.background,
    text: colors.ink,
    border: colors.line,
    notification: colors.accent,
  },
  fonts: {
    regular: { fontFamily: "System", fontWeight: "400" },
    medium: { fontFamily: "System", fontWeight: "500" },
    bold: { fontFamily: "System", fontWeight: "700" },
    heavy: { fontFamily: "System", fontWeight: "800" },
  },
};

export type AppNavigatorScreens = {
  [RouteName in keyof RootStackParamList]: React.ComponentType<
    ScreenProps<RouteName>
  >;
};

export function AppNavigator({
  screens,
  initialRouteName = "Welcome",
  onReady,
  onRouteChange,
}: {
  screens: AppNavigatorScreens;
  initialRouteName?: "Welcome" | "Unlock";
  onReady?: () => void;
  onRouteChange?: (route: keyof RootStackParamList) => void;
}) {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const reportRoute = () => {
    const route = navigationRef.getCurrentRoute();
    if (route) onRouteChange?.(route.name);
  };
  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme} onReady={() => { reportRoute(); onReady?.(); }} onStateChange={reportRoute}>
      <Stack.Navigator
        initialRouteName={initialRouteName}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: navigationTheme.colors.background },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="Welcome" component={screens.Welcome} />
        <Stack.Screen name="WalletSetup" component={screens.WalletSetup} />
        <Stack.Screen name="Create" component={screens.Create} />
        <Stack.Screen name="CreateVerify" component={screens.CreateVerify} />
        <Stack.Screen name="Import" component={screens.Import} />
        <Stack.Screen name="Unlock" component={screens.Unlock} />
        <Stack.Screen name="Main" component={screens.Main} />
        <Stack.Screen name="Accounts" component={screens.Accounts} />
        <Stack.Screen name="Networks" component={screens.Networks} />
        <Stack.Screen name="Rpc" component={screens.Rpc} />
        <Stack.Screen name="Assets" component={screens.Assets} />
        <Stack.Screen name="Asset" component={screens.Asset} />
        <Stack.Screen name="Send" component={screens.Send} />
        <Stack.Screen name="Receive" component={screens.Receive} />
        <Stack.Screen name="Transaction" component={screens.Transaction} />
        <Stack.Screen name="Browser" component={screens.Browser} />
        <Stack.Screen name="Permission" component={screens.Permission} />
        <Stack.Screen name="SignRequest" component={screens.SignRequest} />
        <Stack.Screen name="Settings" component={screens.Settings} />
        <Stack.Screen name="InviteFriends" component={screens.InviteFriends} />
        <Stack.Screen
          name="LanguageSettings"
          component={screens.LanguageSettings}
        />
        <Stack.Screen
          name="SecuritySettings"
          component={screens.SecuritySettings}
        />
        <Stack.Screen name="Password" component={screens.Password} />
        <Stack.Screen name="About" component={screens.About} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
