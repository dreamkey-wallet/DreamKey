import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SecureModal as Modal } from './SecureModal.js';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, CameraType } from 'react-native-camera-kit';
import { check, PERMISSIONS, request, RESULTS, type Permission, type PermissionStatus } from 'react-native-permissions';
import { QrCode, X } from './icons.js';

interface QrScannerModalProps {
  visible: boolean;
  title: string;
  hint: string;
  closeLabel: string;
  permissionDeniedLabel: string;
  onClose: () => void;
  onScanned: (value: string) => void;
}

// Reopening a scanner while an OS prompt is pending must reuse that request.
let pendingCameraPermission: Promise<PermissionStatus> | null = null;
function requestCameraPermission(permission: Permission): Promise<PermissionStatus> {
  if (!pendingCameraPermission) {
    pendingCameraPermission = request(permission).finally(() => { pendingCameraPermission = null; });
  }
  return pendingCameraPermission;
}

export function QrScannerModal({ visible, title, hint, closeLabel, permissionDeniedLabel, onClose, onScanned }: QrScannerModalProps) {
  const sessionRef = useRef({ id: 0, visible, active: false, closed: false, handled: false });
  if (sessionRef.current.visible !== visible) {
    sessionRef.current = { id: sessionRef.current.id + 1, visible, active: false, closed: false, handled: false };
  }
  const session = sessionRef.current;
  const [readySession, setReadySession] = useState<number | null>(null);
  const [deniedSession, setDeniedSession] = useState<number | null>(null);
  const ready = visible && readySession === session.id && !session.closed;
  const permissionDenied = visible && deniedSession === session.id;

  useEffect(() => {
    session.active = visible;
    if (!visible) return;
    const isCurrent = () => sessionRef.current === session && session.active && !session.closed;
    const permission = Platform.OS === 'ios' ? PERMISSIONS.IOS.CAMERA : PERMISSIONS.ANDROID.CAMERA;
    void check(permission).then((status) => {
      if (!isCurrent()) return undefined;
      return status === RESULTS.DENIED ? requestCameraPermission(permission) : status;
    }).then((status) => {
      if (!isCurrent() || status === undefined) return;
      const granted = status === RESULTS.GRANTED || status === RESULTS.LIMITED;
      setDeniedSession(granted ? null : session.id);
      setReadySession(granted ? session.id : null);
    }).catch(() => {
      if (isCurrent()) {
        setDeniedSession(session.id);
        setReadySession(null);
      }
    });
    return () => { session.active = false; };
  }, [session, visible]);

  const close = () => {
    session.closed = true;
    setReadySession(null);
    onClose();
  };

  const handleRead = (event: { nativeEvent: { codeStringValue?: string } }) => {
    const value = event.nativeEvent.codeStringValue?.trim();
    if (!visible || !ready || sessionRef.current !== session || !session.active
      || session.closed || session.handled || !value) return;
    session.handled = true;
    session.closed = true;
    setReadySession(null);
    try { onScanned(value); } finally { onClose(); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.titleRow}><View style={styles.icon}><QrCode size={20} color="#a895ff" /></View><Text style={styles.title}>{title}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} onPress={close} style={({ pressed }) => [styles.close, pressed && styles.pressed]}><X size={22} color="#f7f9ff" /></Pressable>
        </View>
        <View style={styles.cameraWrap}>
          {visible && ready ? <Camera
            key={session.id}
            style={styles.camera}
            cameraType={CameraType.Back}
            scanBarcode
            showFrame
            laserColor="#a895ff"
            frameColor="#a895ff"
            onReadCode={handleRead}
            allowedBarcodeTypes={['qr']}
          /> : null}
          {!ready && !permissionDenied ? <View style={styles.status}><ActivityIndicator color="#a895ff" /><Text style={styles.statusText}>{hint}</Text></View> : null}
          {permissionDenied ? <View style={styles.status}><Text style={styles.statusText}>{permissionDeniedLabel}</Text></View> : null}
        </View>
        {!permissionDenied ? <Text style={styles.hint}>{hint}</Text> : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0c1224' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 },
  titleRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 12 },
  icon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2a2450' },
  title: { flex: 1, color: '#f7f9ff', fontSize: 19, lineHeight: 26, fontWeight: '700' },
  close: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#19233d' },
  pressed: { opacity: 0.7 },
  cameraWrap: { flex: 1, margin: 20, overflow: 'hidden', borderRadius: 24, backgroundColor: '#10192e' },
  camera: { flex: 1 },
  status: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32, backgroundColor: 'rgba(12,18,36,0.72)' },
  statusText: { color: '#f7f9ff', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  hint: { color: '#a8b1c7', fontSize: 14, lineHeight: 21, textAlign: 'center', paddingHorizontal: 28, paddingBottom: 24 },
});
