import { getBytes, hexlify, isHexString, toUtf8Bytes, toUtf8String, TypedDataEncoder, type TypedDataDomain, type TypedDataField } from 'ethers';
import { providerErrors } from './errors.js';

export interface SigningTypedData {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  message: Record<string, unknown>;
  primaryType?: string;
}

export interface SignaturePreview {
  kind: 'text' | 'binary' | 'typedData';
  account: string;
  message?: string;
  /** Original request hex, or exact UTF-8 hex for text containing controls. */
  rawMessage?: string;
  typedData?: SigningTypedData;
}

/** Both approval previews and the signer normalize the same request value. */
export function normalizeSigningMessage(value: unknown): string | Uint8Array {
  if (typeof value !== 'string') throw providerErrors.invalidParams('Message must be a string or hex string');
  if (!isHexString(value)) return value;
  try {
    return getBytes(value);
  } catch {
    throw providerErrors.invalidParams('Hex messages must contain complete bytes');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Retain every signed field; EIP712Domain is supplied separately to ethers. */
export function parseSigningTypedData(value: unknown): SigningTypedData {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw providerErrors.invalidParams('Typed data must be valid JSON'); }
  }
  if (!isPlainObject(parsed)) throw providerErrors.invalidParams('Typed data is required');
  const input = parsed;
  if (!isPlainObject(input.domain) || !isPlainObject(input.types) || !isPlainObject(input.message)) {
    throw providerErrors.invalidParams('Typed data requires domain, types and message objects');
  }
  const types = { ...(input.types as Record<string, TypedDataField[]>) };
  delete types.EIP712Domain;
  let primaryType: string;
  try {
    // This is the type ethers actually hashes. Reject a conflicting label so
    // the approval cannot show a different primary type from the signed data.
    primaryType = TypedDataEncoder.from(types).primaryType;
  } catch {
    throw providerErrors.invalidParams('Typed data has invalid type definitions');
  }
  if (input.primaryType !== undefined && input.primaryType !== primaryType) {
    throw providerErrors.invalidParams('Typed data primaryType does not match the type definitions');
  }
  return {
    domain: input.domain as TypedDataDomain,
    types,
    message: input.message as Record<string, unknown>,
    primaryType,
  };
}

// Tabs and line breaks are useful in login messages. Other controls and bidi
// overrides can hide or reorder bytes, so keep those hex payloads explicit.
const unreadableControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Decode only for display. Never feed decoded text back into signing. */
export function getSignaturePreview(method: string, params: unknown[]): SignaturePreview | undefined {
  const isMessage = method === 'personal_sign' || method === 'eth_sign';
  const isTypedData = method === 'eth_signTypedData' || method === 'eth_signTypedData_v3' || method === 'eth_signTypedData_v4';
  if (!isMessage && !isTypedData) return undefined;
  const account = method === 'personal_sign' ? params[1] : params[0];
  if (typeof account !== 'string') throw providerErrors.invalidParams('An account address is required');
  if (isTypedData) return { kind: 'typedData', account, typedData: parseSigningTypedData(params[1]) };

  const value = method === 'personal_sign' ? params[0] : params[1];
  const normalized = normalizeSigningMessage(value);
  if (typeof normalized === 'string') {
    if (!unreadableControls.test(normalized)) return { kind: 'text', account, message: normalized };
    const rawMessage = hexlify(toUtf8Bytes(normalized));
    return { kind: 'binary', account, message: rawMessage, rawMessage };
  }

  const rawMessage = value as string;
  try {
    // ethers defaults to strict UTF-8 decoding, rather than silently replacing
    // invalid sequences and making the displayed message differ from its bytes.
    const message = toUtf8String(normalized);
    if (!unreadableControls.test(message)) return { kind: 'text', account, message, rawMessage };
  } catch {
    // A byte payload is still signable even when it is not readable UTF-8.
  }
  return { kind: 'binary', account, message: rawMessage, rawMessage };
}
