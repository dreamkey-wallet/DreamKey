package com.dreamkey.wallet;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Shares only generated PNG files from a dedicated private cache directory. */
public final class DreamKeyInviteShareModule extends ReactContextBaseJavaModule {
  private static final int MAX_BASE64_LENGTH = 16 * 1024 * 1024;
  private static final long CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000L;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();

  DreamKeyInviteShareModule(ReactApplicationContext context) {
    super(context);
  }

  @Override
  public String getName() {
    return "DreamKeyInviteShare";
  }

  @ReactMethod
  public void shareImage(String pngBase64, String message, String title, Promise promise) {
    if (pngBase64 == null || pngBase64.isEmpty() || pngBase64.length() > MAX_BASE64_LENGTH) {
      promise.reject("E_SHARE_IMAGE", "Invalid invitation image");
      return;
    }
    try {
      executor.execute(() -> {
        File imageFile = null;
        try {
          byte[] png = Base64.decode(pngBase64, Base64.DEFAULT);
          if (!isPng(png)) throw new IllegalArgumentException("Invalid invitation image");
          BitmapFactory.Options bounds = new BitmapFactory.Options();
          bounds.inJustDecodeBounds = true;
          BitmapFactory.decodeByteArray(png, 0, png.length, bounds);
          if (bounds.outWidth <= 0 || bounds.outHeight <= 0
              || bounds.outWidth > 4096 || bounds.outHeight > 4096) {
            throw new IllegalArgumentException("Invalid invitation image dimensions");
          }
          File directory = new File(getReactApplicationContext().getCacheDir(), "invite-shares");
          if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Unable to create invitation cache");
          }
          removeExpiredImages(directory);
          imageFile = File.createTempFile("dreamkey-invite-", ".png", directory);
          try (FileOutputStream output = new FileOutputStream(imageFile)) {
            output.write(png);
          }
          Uri imageUri = FileProvider.getUriForFile(getReactApplicationContext(),
              getReactApplicationContext().getPackageName() + ".invite-share", imageFile);
          File readyImage = imageFile;
          UiThreadUtil.runOnUiThread(() -> presentShare(imageUri, readyImage, message, title, promise));
        } catch (IllegalArgumentException exception) {
          if (imageFile != null) imageFile.delete();
          promise.reject("E_SHARE_IMAGE", "Invalid invitation image", exception);
        } catch (Exception exception) {
          if (imageFile != null) imageFile.delete();
          promise.reject("E_SHARE_IMAGE", "Unable to prepare invitation image", exception);
        }
      });
    } catch (RejectedExecutionException exception) {
      promise.reject("E_SHARE_UNAVAILABLE", "Image sharing is unavailable", exception);
    }
  }

  private void presentShare(Uri imageUri, File imageFile, String message, String title, Promise promise) {
    Activity activity = getCurrentActivity();
    if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
      imageFile.delete();
      promise.reject("E_SHARE_UNAVAILABLE", "No active screen for sharing");
      return;
    }
    try {
      Intent share = new Intent(Intent.ACTION_SEND);
      share.setType("image/png");
      share.putExtra(Intent.EXTRA_STREAM, imageUri);
      share.putExtra(Intent.EXTRA_TEXT, message == null ? "" : message);
      share.putExtra(Intent.EXTRA_SUBJECT, title == null ? "DreamKey" : title);
      ClipData imageClip = ClipData.newUri(activity.getContentResolver(), "DreamKey invitation", imageUri);
      share.setClipData(imageClip);
      share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      Intent chooser = Intent.createChooser(share, title);
      chooser.setClipData(imageClip);
      chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      activity.startActivity(chooser);
      // Android does not report whether a receiver sent the content. Opening or
      // dismissing the sheet is not a share failure; retain the file for receivers.
      promise.resolve(null);
    } catch (Exception exception) {
      imageFile.delete();
      promise.reject("E_SHARE_UNAVAILABLE", "Unable to open image sharing", exception);
    }
  }

  private static boolean isPng(byte[] data) {
    return data.length >= 33 && data[0] == (byte) 0x89 && data[1] == 0x50
        && data[2] == 0x4e && data[3] == 0x47 && data[4] == 0x0d
        && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a
        && data[8] == 0 && data[9] == 0 && data[10] == 0 && data[11] == 13
        && data[12] == 'I' && data[13] == 'H' && data[14] == 'D' && data[15] == 'R'
        && isAllowedPngDimension(data, 16) && isAllowedPngDimension(data, 20);
  }

  private static boolean isAllowedPngDimension(byte[] data, int offset) {
    long dimension = ((long) (data[offset] & 0xff) << 24)
        | ((long) (data[offset + 1] & 0xff) << 16)
        | ((long) (data[offset + 2] & 0xff) << 8)
        | (data[offset + 3] & 0xff);
    return dimension > 0 && dimension <= 4096;
  }

  private static void removeExpiredImages(File directory) {
    File[] images = directory.listFiles();
    if (images == null) return;
    long oldestAllowed = System.currentTimeMillis() - CACHE_LIFETIME_MS;
    for (File image : images) {
      if (image.isFile() && image.lastModified() < oldestAllowed) image.delete();
    }
  }

  @Override
  public void invalidate() {
    executor.shutdown();
    super.invalidate();
  }
}
