package com.dreamkey.wallet;

import android.content.Context;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.AtomicFile;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** Process-local owner of update state. Every launch decision is persisted before executing JS. */
final class DreamKeyUpdateStore {
  // The constructor always stores getApplicationContext(), never an Activity.
  @SuppressLint("StaticFieldLeak")
  private static DreamKeyUpdateStore instance;
  static synchronized DreamKeyUpdateStore get(Context context) throws Exception {
    if (instance == null) instance = new DreamKeyUpdateStore(context.getApplicationContext());
    return instance;
  }

  final Context context;
  final AtomicBoolean busy = new AtomicBoolean(false);
  final String appVersion;
  private final File root;
  private final AtomicFile stateFile;
  private final File apkDirectory;
  private int active;
  private int pending;
  private int attempting;
  private int highest;
  private int failed;
  private int running;
  private boolean rollback;
  private boolean selected;
  private String bundlePath;
  private String apkVersion = "";
  private String apkFileName = "dreamkey-update.apk";
  private final Set<String> installerFiles = new HashSet<>();

  private DreamKeyUpdateStore(Context app) throws Exception {
    context = app;
    PackageInfo installed = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
    appVersion = installed.versionName == null ? "" : installed.versionName;
    // A new native APK starts a separate compatibility domain, even if a publisher
    // accidentally reuses versionName. It cannot pick up an older APK's patch.
    root = new File(new File(app.getNoBackupFilesDir(), "dreamkey-updates"),
        "native-" + versionCode(installed));
    if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create update storage");
    apkDirectory = new File(app.getCacheDir(), "updates/apk");
    stateFile = new AtomicFile(new File(root, "state.json"));
    load();
    if (attempting > 0) {
      failed = Math.max(failed, attempting);
      highest = Math.max(highest, attempting);
      attempting = 0;
      rollback = true;
      save();
    }
    // A process may die after the verified directory rename but before the
    // atomic state commit. Such a directory is not a release and must not
    // permanently prevent that same bundle version from being downloaded.
    cleanup();
  }

  static String selectBundle(Context context) {
    if (BuildConfig.DEBUG) return null;
    try { return get(context).select(); }
    catch (Exception ignored) { return null; } // Always retain the APK's embedded recovery bundle.
  }

  private synchronized String select() throws Exception {
    if (selected) return bundlePath;
    if (pending > 0) {
      int next = pending;
      try {
        DreamKeyUpdateVerifier.Verified verified = DreamKeyUpdateVerifier.verifyDirectory(
            context, release(next), appVersion, next);
        attempting = next;
        pending = 0;
        // A new patch is now being attempted. Do not carry a rollback notice
        // from an older failed patch into this launch; if this attempt fails,
        // the constructor/selector will set rollback again for this version.
        rollback = false;
        save(); // A process death before confirmation will trigger rollback on the next launch.
        running = next;
        bundlePath = new File(release(next), verified.entryFile).getAbsolutePath();
        selected = true;
        return bundlePath;
      } catch (Exception exception) {
        failed = Math.max(failed, next);
        highest = Math.max(highest, next);
        attempting = 0;
        pending = 0;
        rollback = true;
        save();
      }
    }
    if (active > 0) {
      try {
        DreamKeyUpdateVerifier.Verified verified = DreamKeyUpdateVerifier.verifyDirectory(
            context, release(active), appVersion, active);
        running = active;
        bundlePath = new File(release(active), verified.entryFile).getAbsolutePath();
        selected = true;
        return bundlePath;
      } catch (Exception exception) {
        failed = Math.max(failed, active);
        highest = Math.max(highest, active);
        active = 0;
        rollback = true;
        save();
      }
    }
    running = 0;
    bundlePath = null;
    selected = true;
    return null;
  }

  synchronized JSONObject state() throws Exception {
    // OTA validation uses the manifest, file sizes, and SHA-256 hashes. It does
    // not depend on a separately configured signing key.
    boolean supported = !BuildConfig.DEBUG;
    boolean ready = false;
    if (!apkVersion.isEmpty() && apk().isFile()) {
      try { verifyApk(apk(), apkVersion); ready = true; }
      catch (Exception ignored) { apkVersion = ""; apk().delete(); save(); }
    }
    return new JSONObject().put("appVersion", appVersion).put("bundleVersion", running)
        .put("pendingBundleVersion", pending).put("highestBundleVersion", highest)
        .put("failedBundleVersion", failed).put("rollback", rollback).put("supported", supported)
        .put("apkReady", ready).put("apkVersion", ready ? apkVersion : "");
  }

  synchronized void acknowledgeRollback() throws Exception {
    if (!rollback) return;
    rollback = false;
    try { save(); }
    catch (Exception exception) { rollback = true; throw exception; }
  }

  void stage(String url, String expectedApp, int version, DreamKeyUpdateDownload.Progress progress)
      throws Exception {
    if (BuildConfig.DEBUG) throw new DreamKeyUpdateException("E_UPDATE_UNSUPPORTED",
        "OTA is only available in release builds", null);
    synchronized (this) {
      if (attempting > 0) {
        throw new DreamKeyUpdateException("E_UPDATE_BUSY", "Wait for the current update launch to be confirmed", null);
      }
      if (!appVersion.equals(expectedApp) || version <= highest || version <= 0) {
        throw new DreamKeyUpdateException("E_UPDATE_VERSION",
            "Update is incompatible, already installed, or previously rejected", null);
      }
    }
    File zip = new File(root, "download.zip.part");
    File staging = new File(root, "staging");
    File destination = release(version);
    boolean renamed = false;
    boolean committed = false;
    deleteTree(staging);
    if (!staging.mkdir()) throw new IOException("Cannot create update staging directory");
    try {
      DreamKeyUpdateDownload.download(url, zip, 50L * 1024 * 1024, progress);
      try { DreamKeyUpdateVerifier.extract(context, zip, staging, expectedApp, version); }
      catch (Exception exception) {
        throw new DreamKeyUpdateException("E_UPDATE_VERIFY", "Update contents failed verification", exception);
      }
      DreamKeyUpdateVerifier.checkInterrupted();
      synchronized (this) {
        if (destination.exists()) {
          if (version == active || version == pending || version == attempting || version == running) {
            throw new IOException("Update destination is already in use");
          }
          deleteTree(destination);
        }
      }
      if (!staging.renameTo(destination)) throw new IOException("Cannot activate verified update files");
      renamed = true;
      synchronized (this) {
        DreamKeyUpdateVerifier.checkInterrupted();
        int previous = pending, previousHighest = highest;
        pending = version;
        highest = version;
        try { save(); }
        catch (Exception exception) { pending = previous; highest = previousHighest; deleteTree(destination); throw exception; }
        committed = true;
      }
      cleanup();
    } finally {
      zip.delete();
      deleteTree(staging);
      if (renamed && !committed) deleteTree(destination);
    }
  }

  synchronized void confirm() throws Exception {
    if (attempting > 0 && attempting == running) {
      // Verify again before replacing the previous known-good release.
      DreamKeyUpdateVerifier.verifyDirectory(context, release(running), appVersion, running);
      int previousActive = active;
      int previousAttempting = attempting;
      boolean previousRollback = rollback;
      active = running;
      attempting = 0;
      rollback = false;
      try { save(); }
      catch (Exception exception) {
        // Keep disk and memory in agreement. Otherwise a later cleanup could
        // delete the last-good patch that the durable state still references.
        active = previousActive;
        attempting = previousAttempting;
        rollback = previousRollback;
        throw exception;
      }
      cleanup();
    }
  }

  void downloadApk(String url, String expectedVersion, DreamKeyUpdateDownload.Progress progress)
      throws Exception {
    if (expectedVersion == null || !expectedVersion.matches("[0-9]+(?:\\.[0-9]+){1,3}")) {
      throw new IOException("Invalid APK target version");
    }
    if (!apkDirectory.isDirectory() && !apkDirectory.mkdirs()) throw new IOException("Cannot create APK cache");
    File temporary = new File(apkDirectory, "download.apk.part");
    try {
      DreamKeyUpdateDownload.download(url, temporary, 300L * 1024 * 1024, progress);
      try { verifyApk(temporary, expectedVersion); }
      catch (Exception exception) {
        throw new DreamKeyUpdateException("E_UPDATE_VERIFY", "APK signature, package or version failed verification", exception);
      }
      commitApk(temporary, expectedVersion);
    } finally { temporary.delete(); }
  }

  private synchronized void commitApk(File temporary, String expectedVersion) throws Exception {
    DreamKeyUpdateVerifier.checkInterrupted();
    // Keep the previous verified APK intact until the new file and its atomic
    // state pointer have both been committed. A process death in between only
    // leaves an unreferenced cache file, never a state pointing at other bytes.
    File destination = File.createTempFile("dreamkey-update-", ".apk", apkDirectory);
    if (!destination.delete() || !temporary.renameTo(destination)) {
      destination.delete();
      throw new IOException("Cannot save verified APK");
    }
    String previousVersion = apkVersion, previousFile = apkFileName;
    apkVersion = expectedVersion;
    apkFileName = destination.getName();
    try { save(); }
    catch (Exception exception) {
      apkVersion = previousVersion;
      apkFileName = previousFile;
      destination.delete();
      throw exception;
    }
    File previous = new File(apkDirectory, previousFile);
    if (!previous.equals(destination) && !installerFiles.contains(previousFile)) previous.delete();
    cleanupApks();
  }

  synchronized Intent installIntent() throws Exception {
    if (apkVersion.isEmpty() || !apk().isFile()) throw new IOException("Download the APK before installing");
    verifyApk(apk(), apkVersion);
    Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".updates", apk());
    Intent install = new Intent(Intent.ACTION_VIEW);
    install.setDataAndType(uri, "application/vnd.android.package-archive");
    install.setClipData(android.content.ClipData.newRawUri("DreamKey update", uri));
    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    // The system installer opens the granted URI asynchronously. A concurrent
    // later download must not delete the immutable APK that intent references.
    installerFiles.add(apkFileName);
    return install;
  }

  boolean canInstall() {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls();
  }

  // Only called when canInstall() is false, which can only occur on Android O+.
  @SuppressLint("InlinedApi")
  Intent installationPermissionIntent() {
    return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:" + context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
  }

  private void verifyApk(File file, String expected) throws Exception {
    PackageManager packages = context.getPackageManager();
    int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    PackageInfo archive = packages.getPackageArchiveInfo(file.getAbsolutePath(), flags);
    PackageInfo installed = packages.getPackageInfo(context.getPackageName(), flags);
    if (archive == null || !context.getPackageName().equals(archive.packageName)
        || !"com.dreamkey.wallet".equals(archive.packageName)
        || !expected.equals(archive.versionName) || versionCode(archive) <= versionCode(installed)
        || !signatures(archive).equals(signatures(installed)) || signatures(installed).isEmpty()) {
      throw new IOException("APK package, version, or signing certificate does not match");
    }
    if (archive.applicationInfo == null || (archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)) {
      throw new IOException("APK is not compatible with this Android version");
    }
  }

  @SuppressWarnings("deprecation")
  private static long versionCode(PackageInfo info) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
  }

  @SuppressWarnings("deprecation")
  private static Set<String> signatures(PackageInfo info) {
    Signature[] values = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
    Set<String> result = new HashSet<>();
    if (values != null) for (Signature signature : values) result.add(signature.toCharsString());
    return result;
  }

  private File apk() { return new File(apkDirectory, apkFileName); }
  private File release(int version) { return new File(root, "bundle-" + version); }

  private synchronized void load() {
    try (FileInputStream input = stateFile.openRead()) {
      JSONObject json = new JSONObject(new String(DreamKeyUpdateVerifier.readLimited(input, 16384), StandardCharsets.UTF_8));
      if (!appVersion.equals(json.getString("appVersion"))) return;
      active = boundedVersion(json, "active");
      pending = boundedVersion(json, "pending");
      attempting = boundedVersion(json, "attempting");
      highest = Math.max(boundedVersion(json, "highest"), Math.max(active, Math.max(pending, attempting)));
      failed = boundedVersion(json, "failed");
      highest = Math.max(highest, failed);
      rollback = json.optBoolean("rollback", false);
      apkVersion = json.optString("apkVersion", "");
      String savedApk = json.optString("apkFile", "dreamkey-update.apk");
      if (!savedApk.matches("dreamkey-update(?:-[0-9]+)?\\.apk")) throw new IOException("Invalid APK cache path");
      apkFileName = savedApk;
    } catch (Exception ignored) {
      // A missing/corrupt state never loads unverified code.
      active = 0; pending = 0; attempting = 0; highest = 0; failed = 0; apkVersion = "";
      apkFileName = "dreamkey-update.apk";
    }
  }

  private static int boundedVersion(JSONObject state, String key) throws Exception {
    long value = state.optLong(key, 0);
    if (value < 0 || value > Integer.MAX_VALUE) throw new IOException("Invalid saved update state");
    return (int) value;
  }

  private synchronized void save() throws Exception {
    JSONObject json = new JSONObject().put("appVersion", appVersion).put("active", active)
        .put("pending", pending).put("attempting", attempting).put("highest", highest)
        .put("failed", failed).put("rollback", rollback).put("apkVersion", apkVersion).put("apkFile", apkFileName);
    FileOutputStream output = null;
    try {
      output = stateFile.startWrite();
      output.write(json.toString().getBytes(StandardCharsets.UTF_8));
      stateFile.finishWrite(output);
    } catch (Exception exception) {
      if (output != null) stateFile.failWrite(output);
      throw exception;
    }
  }

  private synchronized void cleanup() {
    File[] files = root.listFiles();
    if (files == null) return;
    for (File file : files) {
      if (file.isDirectory() && file.getName().startsWith("bundle-")
          && !file.equals(release(active)) && !file.equals(release(pending))
          && !file.equals(release(attempting)) && !file.equals(release(running))) {
        try { deleteTree(file); } catch (IOException ignored) { /* Reclaim on the next successful update. */ }
      }
    }
  }

  private synchronized void cleanupApks() {
    File[] files = apkDirectory.listFiles();
    if (files == null) return;
    for (File file : files) {
      if (file.isFile() && file.getName().matches("dreamkey-update(?:-[0-9]+)?\\.apk")
          && !file.equals(apk()) && !installerFiles.contains(file.getName())) {
        file.delete();
      }
    }
  }

  private static void deleteTree(File file) throws IOException {
    if (!file.exists()) return;
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children == null) throw new IOException("Cannot remove update staging files");
      for (File child : children) {
        if (!child.getCanonicalPath().startsWith(file.getCanonicalPath() + File.separator)) {
          throw new IOException("Unsafe update cleanup path");
        }
        deleteTree(child);
      }
    }
    if (!file.delete()) throw new IOException("Cannot remove update staging file");
  }
}
