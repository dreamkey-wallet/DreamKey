package com.dreamkey.wallet;

import java.io.IOException;

final class DreamKeyUpdateException extends IOException {
  final String code;
  DreamKeyUpdateException(String code, String message, Exception cause) {
    super(message, cause);
    this.code = code;
  }
}
