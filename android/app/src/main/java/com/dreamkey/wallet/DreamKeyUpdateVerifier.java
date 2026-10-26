package com.dreamkey.wallet;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Bounded extraction and offline revalidation of immutable OTA releases. */
final class DreamKeyUpdateVerifier {
  static final long MAX_FILE = 50L * 1024 * 1024;
  private static final long MAX_EXPANDED = 150L * 1024 * 1024;
  private static final int MAX_ENTRIES = 1000;
  private static final int MAX_MANIFEST = 256 * 1024;

  static final class Verified {
    final String appVersion;
    final int bundleVersion;
    final String entryFile;
    final Map<String, PayloadFile> files;
    Verified(String app, int bundle, String entry, Map<String, PayloadFile> payload) {
      appVersion = app; bundleVersion = bundle; entryFile = entry; files = payload;
    }
  }

  private static final class PayloadFile {
    final String hash;
    final long size;
    PayloadFile(String hash, long size) { this.hash = hash; this.size = size; }
  }

  static Verified extract(Context context, File archive, File destination, String app, int version)
      throws Exception {
    try (ZipFile zip = new ZipFile(archive)) {
      Map<String, ZipEntry> entries = new HashMap<>();
      Enumeration<? extends ZipEntry> enumeration = zip.entries();
      int count = 0;
      while (enumeration.hasMoreElements()) {
        checkInterrupted();
        ZipEntry entry = enumeration.nextElement();
        if (++count > MAX_ENTRIES) throw new IOException("Too many update files");
        String name = entry.getName();
        checkedPath(name, entry.isDirectory());
        if (entries.put(name, entry) != null) throw new IOException("Duplicate update path");
        if (entry.getSize() > MAX_FILE || entry.getSize() < 0) throw new IOException("Invalid update size");
      }
      String prefix;
      if (entries.containsKey("manifest.json")) prefix = "";
      else if (entries.containsKey("output/manifest.json")) prefix = "output/";
      else throw new IOException("Update manifest is missing");
      byte[] manifest = readZip(zip, entries.get(prefix + "manifest.json"), MAX_MANIFEST);
      Verified verified = manifest(manifest, app, version);
      Set<String> payloadNames = new HashSet<>();
      long expanded = 0;
      for (Map.Entry<String, ZipEntry> item : entries.entrySet()) {
        checkInterrupted();
        String full = item.getKey();
        ZipEntry entry = item.getValue();
        if (!full.startsWith(prefix)) throw new IOException("Unexpected update root");
        String name = full.substring(prefix.length());
        if (entry.isDirectory()) {
          if (!name.isEmpty()) checkedPath(name, true);
          continue;
        }
        // manifest.sig is tolerated for compatibility with packages produced by
        // older publishers, but it is not read or trusted by the unsigned format.
        if (name.equals("manifest.json") || name.equals("manifest.sig")) continue;
        PayloadFile expected = verified.files.get(name);
        if (expected == null || !payloadNames.add(name) || entry.getSize() != expected.size) {
          throw new IOException("Unexpected update file: " + name);
        }
        expanded += expected.size;
        if (expanded > MAX_EXPANDED) throw new IOException("Expanded update exceeds size limit");
        File output = within(destination, name);
        File parent = output.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create update directory");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        long received = 0;
        try (InputStream input = zip.getInputStream(entry);
            FileOutputStream stream = new FileOutputStream(output)) {
          byte[] buffer = new byte[32768];
          int read;
          while ((read = input.read(buffer)) != -1) {
            checkInterrupted();
            received += read;
            if (received > expected.size || received > MAX_FILE) throw new IOException("Invalid expanded file size");
            hash.update(buffer, 0, read);
            stream.write(buffer, 0, read);
          }
          stream.getFD().sync();
        }
        if (received != expected.size || !hex(hash.digest()).equals(expected.hash)) {
          throw new IOException("Update file integrity check failed");
        }
      }
      if (!payloadNames.equals(verified.files.keySet())) throw new IOException("Update file is missing");
      write(new File(destination, "manifest.json"), manifest);
      return verified;
    }
  }

  static Verified verifyDirectory(Context context, File directory, String app, int version) throws Exception {
    byte[] manifest;
    try (InputStream input = new FileInputStream(within(directory, "manifest.json"))) {
      manifest = readLimited(input, MAX_MANIFEST);
    }
    Verified verified = manifest(manifest, app, version);
    Set<String> actual = new HashSet<>();
    enumerate(directory, directory, actual);
    actual.remove("manifest.json"); actual.remove("manifest.sig");
    if (!actual.equals(verified.files.keySet())) throw new IOException("Unexpected local update files");
    for (Map.Entry<String, PayloadFile> item : verified.files.entrySet()) {
      checkInterrupted();
      File file = within(directory, item.getKey());
      PayloadFile expected = item.getValue();
      if (!file.isFile() || file.length() != expected.size) throw new IOException("Local update file is missing");
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      long size = 0;
      try (InputStream input = new FileInputStream(file)) {
        byte[] buffer = new byte[32768];
        int read;
        while ((read = input.read(buffer)) != -1) {
          checkInterrupted();
          size += read;
          if (size > expected.size) throw new IOException("Local update file changed");
          digest.update(buffer, 0, read);
        }
      }
      if (size != expected.size || !hex(digest.digest()).equals(expected.hash)) {
        throw new IOException("Local update integrity check failed");
      }
    }
    return verified;
  }

  private static Verified manifest(byte[] bytes, String app, int version)
      throws Exception {
    JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    if (exactInteger(json, "schemaVersion") != 1 || !"android".equals(json.getString("platform"))
        || !app.equals(json.getString("appVersion")) || exactInteger(json, "bundleVersion") != version
        || version <= 0 || !"index.android.bundle".equals(json.getString("entryFile"))) {
      throw new IOException("Update is not compatible with this application");
    }
    JSONArray files = json.getJSONArray("files");
    if (files.length() == 0 || files.length() > MAX_ENTRIES - 2) throw new IOException("Invalid update file count");
    Map<String, PayloadFile> entries = new HashMap<>();
    long total = 0;
    for (int index = 0; index < files.length(); index++) {
      JSONObject item = files.getJSONObject(index);
      String path = item.getString("path");
      checkedPath(path, false);
      String hash = item.getString("sha256");
      long size = exactInteger(item, "size");
      if (path.equals("manifest.json") || path.equals("manifest.sig") || !hash.matches("[0-9a-f]{64}")
          || size < 0 || size > MAX_FILE || (path.equals("index.android.bundle") && size == 0)
          || entries.put(path, new PayloadFile(hash, size)) != null) {
        throw new IOException("Invalid update file manifest");
      }
      total += size;
      if (total > MAX_EXPANDED) throw new IOException("Expanded update exceeds size limit");
    }
    if (!entries.containsKey("index.android.bundle")) throw new IOException("Update bundle is missing");
    return new Verified(app, version, "index.android.bundle", entries);
  }

  private static long exactInteger(JSONObject object, String key) throws Exception {
    Object value = object.get(key);
    if (!(value instanceof Integer) && !(value instanceof Long)) throw new IOException("Invalid integer: " + key);
    return ((Number) value).longValue();
  }

  private static void enumerate(File root, File current, Set<String> names) throws Exception {
    File[] files = current.listFiles();
    if (files == null) throw new IOException("Cannot read update directory");
    for (File file : files) {
      checkInterrupted();
      String name = root.toURI().relativize(file.toURI()).getPath();
      within(root, name);
      checkedPath(name, file.isDirectory());
      if (file.isDirectory()) enumerate(root, file, names);
      else if (!names.add(name) || names.size() > MAX_ENTRIES) throw new IOException("Invalid update directory");
    }
  }

  private static byte[] readZip(ZipFile zip, ZipEntry entry, int limit) throws Exception {
    if (entry == null || entry.isDirectory() || entry.getSize() > limit) throw new IOException("Update manifest is missing");
    try (InputStream input = zip.getInputStream(entry)) { return readLimited(input, limit); }
  }

  static byte[] readLimited(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int read;
    while ((read = input.read(buffer)) != -1) {
      checkInterrupted();
      if (output.size() + read > limit) throw new IOException("Update metadata exceeds size limit");
      output.write(buffer, 0, read);
    }
    return output.toByteArray();
  }

  static void checkInterrupted() throws InterruptedIOException {
    if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Update interrupted");
  }

  static File within(File root, String name) throws IOException {
    File file = new File(root, name);
    String prefix = root.getCanonicalPath() + File.separator;
    if (!file.getCanonicalPath().startsWith(prefix)) throw new IOException("Unsafe update path");
    return file;
  }

  private static void checkedPath(String name, boolean directory) throws IOException {
    String path = directory && name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
    if (path.isEmpty() || path.length() > 240 || path.startsWith("/")
        || !path.matches("[A-Za-z0-9_./@+\\-]+")) throw new IOException("Unsafe update path");
    for (String segment : path.split("/", -1)) {
      if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) throw new IOException("Unsafe update path");
    }
  }

  private static void write(File file, byte[] bytes) throws IOException {
    try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); output.getFD().sync(); }
  }

  private static String hex(byte[] bytes) {
    char[] digits = "0123456789abcdef".toCharArray();
    char[] output = new char[bytes.length * 2];
    for (int index = 0; index < bytes.length; index++) {
      output[index * 2] = digits[(bytes[index] & 255) >>> 4];
      output[index * 2 + 1] = digits[bytes[index] & 15];
    }
    return new String(output);
  }

}
