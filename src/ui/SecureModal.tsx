import React from 'react';
import { Modal, Platform, requireNativeComponent, type ModalProps, type ViewProps } from 'react-native';

const SecureSurface = Platform.OS === 'android'
  ? requireNativeComponent<ViewProps>('DreamKeySecureSurface') : null;

/** RN Android Modals create a separate window; protect it as well as the Activity. */
export function SecureModal({ children, ...props }: ModalProps) {
  return <Modal {...props}>
    {SecureSurface ? <SecureSurface collapsable={false} pointerEvents="none" style={{ width: 0, height: 0 }} /> : null}
    {children}
  </Modal>;
}
