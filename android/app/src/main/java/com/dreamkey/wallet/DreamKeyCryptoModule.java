package com.dreamkey.wallet;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Runs password derivation outside the JavaScript and UI threads. */
public final class DreamKeyCryptoModule extends ReactContextBaseJavaModule {
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private volatile boolean invalidated = false;

  DreamKeyCryptoModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public String getName() {
    return "DreamKeyCrypto";
  }

  @ReactMethod
  public void derivePasswordVerifier(
      String passwordUtf8Hex, String saltHex, double iterations, Promise promise) {
    if (invalidated) {
      promise.reject("E_CRYPTO_UNAVAILABLE", "Password derivation is unavailable");
      return;
    }
    if (iterations != DreamKeyPasswordKdf.ITERATIONS) {
      promise.reject("E_CRYPTO_PARAMETERS", "Invalid password derivation parameters");
      return;
    }
    // Decode inside the worker: queued tasks do not retain extra mutable secret buffers.
    try {
      executor.execute(() -> {
        byte[] password = null;
        byte[] salt = null;
        byte[] derived = null;
        try {
          if (invalidated) return;
          password = decodeHex(passwordUtf8Hex, 1, 4096);
          salt = decodeHex(saltHex, 16, 16);
          derived = DreamKeyPasswordKdf.derive(password, salt);
          if (!invalidated) promise.resolve(encodeHex(derived));
        } catch (IllegalArgumentException exception) {
          if (!invalidated) {
            promise.reject("E_CRYPTO_PARAMETERS", "Invalid password derivation parameters");
          }
        } catch (Exception exception) {
          if (!invalidated) {
            promise.reject("E_CRYPTO_DERIVE", "Unable to derive password verifier");
          }
        } finally {
          if (password != null) Arrays.fill(password, (byte) 0);
          if (salt != null) Arrays.fill(salt, (byte) 0);
          if (derived != null) Arrays.fill(derived, (byte) 0);
        }
      });
    } catch (RejectedExecutionException exception) {
      promise.reject("E_CRYPTO_UNAVAILABLE", "Password derivation is unavailable");
    }
  }

  private static byte[] decodeHex(String value, int minimumBytes, int maximumBytes) {
    if (value == null) throw new IllegalArgumentException("Invalid hex");
    int start = value.startsWith("0x") ? 2 : 0;
    int length = value.length() - start;
    if ((length & 1) != 0 || length < minimumBytes * 2 || length > maximumBytes * 2) {
      throw new IllegalArgumentException("Invalid hex length");
    }
    byte[] bytes = new byte[length / 2];
    for (int index = 0; index < bytes.length; index++) {
      int high = hexDigit(value.charAt(start + index * 2));
      int low = hexDigit(value.charAt(start + index * 2 + 1));
      if (high < 0 || low < 0) {
        Arrays.fill(bytes, (byte) 0);
        throw new IllegalArgumentException("Invalid hex character");
      }
      bytes[index] = (byte) ((high << 4) | low);
    }
    return bytes;
  }

  private static int hexDigit(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
  }

  private static String encodeHex(byte[] bytes) {
    char[] digits = "0123456789abcdef".toCharArray();
    char[] encoded = new char[bytes.length * 2 + 2];
    encoded[0] = '0';
    encoded[1] = 'x';
    try {
      for (int index = 0; index < bytes.length; index++) {
        encoded[index * 2 + 2] = digits[(bytes[index] & 0xff) >>> 4];
        encoded[index * 2 + 3] = digits[bytes[index] & 0x0f];
      }
      return new String(encoded);
    } finally {
      Arrays.fill(encoded, '\0');
    }
  }

  @Override
  public void invalidate() {
    invalidated = true;
    executor.shutdownNow();
    super.invalidate();
  }
}
