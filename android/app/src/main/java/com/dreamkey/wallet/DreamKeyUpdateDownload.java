package com.dreamkey.wallet;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

/** Bounded HTTPS downloads; update payloads never enter shared storage. */
final class DreamKeyUpdateDownload {
  interface Progress { void update(long received, long total); }

  static void download(String source, File destination, long limit, Progress progress) throws Exception {
    URL current = checkedUrl(source);
    String originalHost = current.getHost();
    long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MINUTES.toNanos(10);
    for (int redirects = 0; redirects <= 4; redirects++) {
      DreamKeyUpdateVerifier.checkInterrupted();
      checkPublicHost(current.getHost());
      HttpsURLConnection connection = (HttpsURLConnection) current.openConnection();
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(20000);
      connection.setReadTimeout(30000);
      connection.setRequestProperty("Accept-Encoding", "identity");
      connection.setRequestProperty("User-Agent", "DreamKey-Update/1");
      try {
        int status = connection.getResponseCode();
        if (status >= 300 && status <= 399) {
          String location = connection.getHeaderField("Location");
          if (location == null || redirects == 4) throw new IOException("Too many update redirects");
          current = checkedUrl(new URL(current, location).toExternalForm());
          if (!originalHost.equalsIgnoreCase(current.getHost())) {
            throw new IOException("Update redirects must remain on the original host");
          }
          continue;
        }
        if (status != 200) throw new IOException("Update server returned HTTP " + status);
        long declared = connection.getContentLengthLong();
        if (declared > limit) throw new IOException("Update download exceeds size limit");
        long received = 0;
        long lastEvent = 0;
        try (InputStream input = connection.getInputStream();
            FileOutputStream output = new FileOutputStream(destination)) {
          byte[] buffer = new byte[32768];
          int count;
          while ((count = input.read(buffer)) != -1) {
            DreamKeyUpdateVerifier.checkInterrupted();
            if (System.nanoTime() > deadline) throw new IOException("Update download timed out");
            received += count;
            if (received > limit) throw new IOException("Update download exceeds size limit");
            output.write(buffer, 0, count);
            long now = System.currentTimeMillis();
            if (now - lastEvent > 150) { progress.update(received, declared); lastEvent = now; }
          }
          output.getFD().sync();
        }
        DreamKeyUpdateVerifier.checkInterrupted();
        if (received == 0 || (declared >= 0 && received != declared)) {
          throw new IOException("Incomplete update download");
        }
        progress.update(received, declared >= 0 ? declared : received);
        return;
      } finally {
        connection.disconnect();
      }
    }
    throw new IOException("Too many update redirects");
  }

  static URL checkedUrl(String source) throws Exception {
    if (source == null || source.length() > 4096) throw new IOException("Invalid update URL");
    URI uri = new URI(source);
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
        || uri.getRawUserInfo() != null || uri.getRawFragment() != null
        || (uri.getPort() != -1 && uri.getPort() != 443)) {
      throw new IOException("Update URL must use public HTTPS");
    }
    return uri.toURL();
  }

  private static void checkPublicHost(String host) throws Exception {
    InetAddress[] addresses = InetAddress.getAllByName(host);
    if (addresses.length == 0) throw new IOException("Update host is unavailable");
    for (InetAddress address : addresses) {
      byte[] bytes = address.getAddress();
      // isSiteLocalAddress omits IPv6 unique-local and some reserved IPv4 ranges.
      boolean reserved = bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc;
      if (bytes.length == 4) {
        int first = bytes[0] & 255, second = bytes[1] & 255;
        reserved |= first == 0 || first >= 224 || (first == 100 && second >= 64 && second <= 127)
            || (first == 169 && second == 254) || (first == 198 && (second == 18 || second == 19));
      }
      if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
          || address.isSiteLocalAddress() || address.isMulticastAddress() || reserved) {
        throw new IOException("Private update hosts are not allowed");
      }
    }
  }
}
