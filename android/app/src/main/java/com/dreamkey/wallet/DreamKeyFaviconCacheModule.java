package com.dreamkey.wallet;

import android.util.AtomicFile;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Stores public DApp icon records separately from wallet and credential storage. */
public final class DreamKeyFaviconCacheModule extends ReactContextBaseJavaModule {
  private static final int MAX_KEY_LENGTH = 4096;
  private static final int MAX_RECORD_BYTES = 768 * 1024;
  private static final int MAX_RECORDS = 60;
  private static final long MAX_CACHE_BYTES = 8 * 1024 * 1024L;
  // Share the queue across React instance reloads so old and new bridges cannot race.
  private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
  private volatile boolean invalidated;

  DreamKeyFaviconCacheModule(ReactApplicationContext context) {
    super(context);
  }

  @Override
  public String getName() {
    return "DreamKeyFaviconCache";
  }

  @ReactMethod
  public void read(String key, Promise promise) {
    if (!validKey(key)) {
      promise.reject("E_FAVICON_KEY", "Invalid DApp icon cache key");
      return;
    }
    execute("E_FAVICON_READ", "Unable to read DApp icon cache", promise, () -> {
      File file = cacheFile(key);
      AtomicFile atomic = new AtomicFile(file);
      if (!file.exists() && !new File(file.getPath() + ".bak").exists()) {
        promise.resolve(null);
        return;
      }
      byte[] record;
      try (FileInputStream input = atomic.openRead();
          ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[8192];
        int length;
        while ((length = input.read(buffer)) != -1) {
          if (output.size() + length > MAX_RECORD_BYTES) {
            throw new IOException("DApp icon cache record exceeds size limit");
          }
          output.write(buffer, 0, length);
        }
        record = output.toByteArray();
      }
      // Access time is represented by mtime for least-recently-used eviction.
      file.setLastModified(System.currentTimeMillis());
      promise.resolve(new String(record, StandardCharsets.UTF_8));
    });
  }

  @ReactMethod
  public void write(String key, String value, Promise promise) {
    if (!validKey(key)) {
      promise.reject("E_FAVICON_KEY", "Invalid DApp icon cache key");
      return;
    }
    // The UTF-16 length check also avoids allocating an oversized UTF-8 copy.
    if (value == null || value.length() > MAX_RECORD_BYTES) {
      promise.reject("E_FAVICON_SIZE", "DApp icon cache record exceeds size limit");
      return;
    }
    execute("E_FAVICON_WRITE", "Unable to write DApp icon cache", promise, () -> {
      byte[] record = value.getBytes(StandardCharsets.UTF_8);
      if (record.length > MAX_RECORD_BYTES) {
        promise.reject("E_FAVICON_SIZE", "DApp icon cache record exceeds size limit");
        return;
      }
      File file = cacheFile(key);
      AtomicFile atomic = new AtomicFile(file);
      FileOutputStream output = null;
      try {
        output = atomic.startWrite();
        output.write(record);
        atomic.finishWrite(output);
      } catch (Exception exception) {
        if (output != null) atomic.failWrite(output);
        throw exception;
      }
      file.setLastModified(System.currentTimeMillis());
      prune(file);
      promise.resolve(true);
    });
  }

  private static boolean validKey(String key) {
    return key != null && !key.isEmpty() && key.length() <= MAX_KEY_LENGTH;
  }

  private File cacheFile(String key) throws Exception {
    File directory = new File(getReactApplicationContext().getCacheDir(), "dapp-favicons");
    if (!directory.isDirectory() && !directory.mkdirs()) {
      throw new IOException("Unable to create DApp icon cache");
    }
    byte[] hash = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
    char[] hex = new char[hash.length * 2];
    char[] digits = "0123456789abcdef".toCharArray();
    for (int index = 0; index < hash.length; index++) {
      int value = hash[index] & 0xff;
      hex[index * 2] = digits[value >>> 4];
      hex[index * 2 + 1] = digits[value & 0x0f];
    }
    return new File(directory, new String(hex) + ".json");
  }

  private static void prune(File newest) throws IOException {
    File directory = newest.getParentFile();
    File[] entries = directory.listFiles();
    if (entries == null) throw new IOException("Unable to list DApp icon cache");
    // Recover interrupted legacy AtomicFile writes and discard unfinished new files.
    for (File entry : entries) {
      String name = entry.getName();
      if (name.matches("[0-9a-f]{64}\\.json\\.bak")) {
        File original = new File(directory, name.substring(0, name.length() - 4));
        try (FileInputStream ignored = new AtomicFile(original).openRead()) {
          // Opening restores a backup before the cache limits are calculated.
        }
      } else if (name.matches("[0-9a-f]{64}\\.json\\.new") && !entry.delete()) {
        throw new IOException("Unable to remove incomplete DApp icon cache record");
      }
    }
    File[] records = directory.listFiles(file -> file.isFile()
        && file.getName().matches("[0-9a-f]{64}\\.json"));
    if (records == null) throw new IOException("Unable to list DApp icon cache");
    Arrays.sort(records, Comparator.comparingLong(File::lastModified)
        .thenComparingInt(file -> file.equals(newest) ? 1 : 0)
        .thenComparing(File::getName));
    long bytes = 0;
    for (File record : records) bytes += record.length();
    int count = records.length;
    for (File record : records) {
      if (count <= MAX_RECORDS && bytes <= MAX_CACHE_BYTES) break;
      long length = record.length();
      new AtomicFile(record).delete();
      if (record.exists()) throw new IOException("Unable to evict DApp icon cache record");
      bytes -= length;
      count--;
    }
  }

  private interface Operation {
    void run() throws Exception;
  }

  private void execute(String code, String message, Promise promise, Operation operation) {
    try {
      EXECUTOR.execute(() -> {
        try {
          if (invalidated) throw new IllegalStateException("DApp icon cache is unavailable");
          operation.run();
        } catch (Exception exception) {
          // Cache keys and image records must not be exposed in error messages or logs.
          promise.reject(code, message);
        }
      });
    } catch (RejectedExecutionException exception) {
      promise.reject(code, message);
    }
  }

  @Override
  public void invalidate() {
    invalidated = true;
    super.invalidate();
  }
}
