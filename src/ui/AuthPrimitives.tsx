import React from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { colors, styles } from "./appStyles.js";
import { ArrowLeft } from "./icons.js";
import { useI18n } from "../i18n.js";
import { DreamKeyLogo } from "./DreamKeyLogo.js";

export function PrimaryButton({
  title,
  onPress,
  disabled = false,
  loading = false,
  variant = "primary",
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <View style={styles.buttonContent}>
        {loading ? <ActivityIndicator color={variant === "secondary" ? colors.ink : "#fff"} size="small" /> : null}
        <Text
          style={[
            styles.buttonText,
            variant === "secondary" && styles.buttonTextDark,
          ]}
        >
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

export function PageHeader({ title, onBack, disabled = false }: { title: string; onBack: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <View style={styles.pageHeader}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("back")}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onBack}
        style={({ pressed }) => [styles.pageBackButton, disabled && styles.buttonDisabled, pressed && !disabled && styles.homePressed]}
      >
        <ArrowLeft size={22} color={colors.ink} />
      </Pressable>
      <Text style={styles.pageTitle}>{title}</Text>
      <View style={styles.pageHeaderSpacer} />
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  editable = true,
  keyboardType = "default",
  autoCapitalize = "none",
  returnKeyType,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  editable?: boolean;
  keyboardType?: "default" | "decimal-pad" | "url";
  autoCapitalize?: "none" | "sentences";
  returnKeyType?: TextInputProps["returnKeyType"];
  onSubmitEditing?: TextInputProps["onSubmitEditing"];
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={editable}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#7c8aa7"
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        spellCheck={false}
        autoComplete={secureTextEntry ? "off" : undefined}
        textContentType={secureTextEntry ? "none" : undefined}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        style={[styles.field, !editable && styles.fieldDisabled]}
      />
    </View>
  );
}

export function BrandHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.brandHeader}>
      <DreamKeyLogo size={42} style={styles.brandLogo} />
      <View style={styles.brandCopy}>
        <Text style={styles.brandTitle}>{title}</Text>
        {subtitle ? <Text style={styles.brandSubtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}
