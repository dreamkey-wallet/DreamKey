package com.dreamkey.wallet;

import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** PBKDF2 uses the supplied UTF-8 bytes directly, including non-ASCII passwords. */
final class DreamKeyPasswordKdf {
  static final int ITERATIONS = 120000;

  private DreamKeyPasswordKdf() {}

  static byte[] derive(byte[] password, byte[] salt) throws GeneralSecurityException {
    byte[] block = new byte[salt.length + 4];
    byte[] u = new byte[32];
    byte[] derived = new byte[32];
    boolean complete = false;
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(password, "HmacSHA256"));
      System.arraycopy(salt, 0, block, 0, salt.length);
      block[block.length - 1] = 1;
      mac.update(block);
      mac.doFinal(u, 0);
      System.arraycopy(u, 0, derived, 0, u.length);
      for (int iteration = 1; iteration < ITERATIONS; iteration++) {
        if ((iteration & 1023) == 0 && Thread.currentThread().isInterrupted()) {
          throw new GeneralSecurityException("Password derivation cancelled");
        }
        mac.update(u);
        mac.doFinal(u, 0);
        for (int byteIndex = 0; byteIndex < derived.length; byteIndex++) {
          derived[byteIndex] ^= u[byteIndex];
        }
      }
      mac.reset();
      complete = true;
      return derived;
    } finally {
      Arrays.fill(block, (byte) 0);
      Arrays.fill(u, (byte) 0);
      if (!complete) Arrays.fill(derived, (byte) 0);
    }
  }
}
