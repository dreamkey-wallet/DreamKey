package com.dreamkey.wallet;

import android.content.Context;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** JVM fixtures use temporary directories and payload hashes only. */
public final class AndroidUpdateVerification {
  static File base;
  static Context context;
  static int checks;
  static int fixtures;
  interface Throwing { void run() throws Exception; }

  public static void main(String[] args) throws Exception {
    base = new File(args[0], "fixtures"); base.mkdirs();
    context = new Context(new File(base, "app"), new byte[0]);
    byte[] bundle = "global.fixture = 'unsigned release';".getBytes(StandardCharsets.UTF_8);
    Map<String, byte[]> payload = new LinkedHashMap<>(); payload.put("index.android.bundle", bundle);
    payload.put("drawable-mdpi/assets_icon.png", new byte[] {1, 2, 3});

    File root = extract(makeZip(1, "", payload, null), 1);
    DreamKeyUpdateVerifier.verifyDirectory(context, root, "1.0.0", 1); checks++;
    File wrapped = extract(makeZip(2, "output/", payload, null), 2);
    DreamKeyUpdateVerifier.verifyDirectory(context, wrapped, "1.0.0", 2); checks++;
    reject("wrong app version", () -> DreamKeyUpdateVerifier.extract(context, makeZip(3,"",payload,null), fresh(), "9.0.0",3));
    reject("wrong bundle version", () -> extract(makeZip(3,"",payload,null),4));
    // Equal-length name replacement makes both local and central names duplicate.
    Map<String,byte[]> repeated=new LinkedHashMap<>(); repeated.put("index.android.bundle",bundle);repeated.put("other.android.bundle",bundle);
    File duplicate=makeZip(3,"",repeated,null);byte[] duplicateBytes=Files.readAllBytes(duplicate.toPath());
    replace(duplicateBytes,"other.android.bundle","index.android.bundle");Files.write(duplicate.toPath(),duplicateBytes);
    final File duplicateZip=duplicate;
    reject("duplicate ZIP paths",()->extract(duplicateZip,3));
    File missing=makeZip(3,"",payload,null);byte[] missingBytes=Files.readAllBytes(missing.toPath());
    replace(missingBytes,"drawable-mdpi/assets_icon.png","drawable-mdpi/absent_icon.png");Files.write(missing.toPath(),missingBytes);
    reject("missing listed ZIP path",()->extract(missing,3));
    Map<String, byte[]> extra = new LinkedHashMap<>(); extra.put("extra.js", bundle);
    reject("unlisted payload", () -> extract(makeZip(3,"",payload,extra),3));
    extra.clear(); extra.put("../outside.js", bundle);
    reject("path traversal", () -> extract(makeZip(3,"",payload,extra),3));
    extra.clear(); extra.put("other/extra.js", bundle);
    reject("mixed roots", () -> extract(makeZip(3,"output/",payload,extra),3));
    Files.write(new File(root,"index.android.bundle").toPath(), "tampered".getBytes(StandardCharsets.UTF_8));
    reject("tampered local bundle", () -> DreamKeyUpdateVerifier.verifyDirectory(context,root,"1.0.0",1));
    Files.write(new File(wrapped,"unexpected.txt").toPath(), bundle);
    reject("unlisted local payload", () -> DreamKeyUpdateVerifier.verifyDirectory(context,wrapped,"1.0.0",2));
    reject("HTTP URL", () -> DreamKeyUpdateDownload.checkedUrl("http://example.com/patch.zip"));
    reject("credential URL", () -> DreamKeyUpdateDownload.checkedUrl("https://user@example.com/patch.zip"));
    reject("nonstandard port URL", () -> DreamKeyUpdateDownload.checkedUrl("https://example.com:8443/patch.zip"));
    Method host = DreamKeyUpdateDownload.class.getDeclaredMethod("checkPublicHost",String.class); host.setAccessible(true);
    reject("loopback host", () -> host.invoke(null,"127.0.0.1"));
    reject("IPv6 local host", () -> host.invoke(null,"::1"));
    reject("private host", () -> host.invoke(null,"10.2.3.4"));
    Thread.currentThread().interrupt();
    try {
      reject("cancelled extraction", () -> extract(makeZip(4,"",payload,null),4));
      reject("cancelled offline validation", () -> DreamKeyUpdateVerifier.verifyDirectory(context,wrapped,"1.0.0",2));
    } finally { Thread.interrupted(); }

    // Create immutable verified release directories and atomic state just as stageBundle does.
    File storeRoot = new File(context.base,"dreamkey-updates/native-1"); storeRoot.mkdirs();
    release(storeRoot,1,payload); release(storeRoot,2,payload); release(storeRoot,99,payload);
    state(storeRoot,0,1,0,1);
    reset();
    check(isBundle(DreamKeyUpdateStore.selectBundle(context),1), "pending selected");
    check(!new File(storeRoot,"bundle-99").exists(),"orphaned pre-commit release is reclaimed on startup");
    // Version 2 was not referenced by the durable state, so recreate the future fixture.
    release(storeRoot,2,payload);
    JSONObject during = DreamKeyUpdateStore.get(context).state();
    check(during.getInt("bundleVersion")==1 && during.getInt("pendingBundleVersion")==0,"pending marked attempting before load");
    reject("unconfirmed launch rejects another patch",()->DreamKeyUpdateStore.get(context).stage("https://example.com/patch.zip","1.0.0",2,(a,b)->{}));
    reset();
    check(DreamKeyUpdateStore.selectBundle(context)==null,"unconfirmed cold launch returns embedded bundle");
    JSONObject crash = DreamKeyUpdateStore.get(context).state();
    check(crash.getBoolean("rollback") && crash.getInt("failedBundleVersion")==1
        && crash.getInt("highestBundleVersion")==1,"failed patch remains blocked");
    check(DreamKeyUpdateStore.get(context).state().getBoolean("rollback"),"reading app version cannot consume rollback notice");
    android.util.AtomicFile.failWrites=true;
    reject("rollback acknowledgement disk failure",()->DreamKeyUpdateStore.get(context).acknowledgeRollback());
    check(DreamKeyUpdateStore.get(context).state().getBoolean("rollback"),"failed acknowledgement preserves rollback notice");
    android.util.AtomicFile.failWrites=false;
    DreamKeyUpdateStore.get(context).acknowledgeRollback();
    reset();
    check(!DreamKeyUpdateStore.get(context).state().getBoolean("rollback"),"explicit rollback acknowledgement survives restart");
    reject("failed patch cannot replay", () -> DreamKeyUpdateStore.get(context).stage("https://example.com/patch.zip","1.0.0",1,(a,b)->{}));
    release(storeRoot,2,payload); state(storeRoot,0,2,0,2); reset();
    check(isBundle(DreamKeyUpdateStore.selectBundle(context),2),"second patch selected");
    check(!DreamKeyUpdateStore.get(context).state().getBoolean("rollback"),"new patch clears stale rollback notice");
    android.util.AtomicFile.failWrites=true;
    reject("launch confirmation disk failure",()->DreamKeyUpdateStore.get(context).confirm());
    Field attemptingField=DreamKeyUpdateStore.class.getDeclaredField("attempting");attemptingField.setAccessible(true);
    check(attemptingField.getInt(DreamKeyUpdateStore.get(context))==2,"failed confirmation preserves in-memory attempting state");
    android.util.AtomicFile.failWrites=false;
    DreamKeyUpdateStore.get(context).confirm();
    reset();
    check(isBundle(DreamKeyUpdateStore.selectBundle(context),2),"confirmed patch survives restart");
    release(storeRoot,3,payload); state(storeRoot,2,3,0,3); reset();
    check(isBundle(DreamKeyUpdateStore.selectBundle(context),3),"new pending selected over last good");
    reset();
    check(isBundle(DreamKeyUpdateStore.selectBundle(context),2),"crash rolls back to last good");
    Files.write(new File(storeRoot,"bundle-2/index.android.bundle").toPath(), bundle);
    // Same-size tampering must also fail offline SHA256 verification.
    byte[] tamper=bundle.clone();tamper[0]^=1;Files.write(new File(storeRoot,"bundle-2/index.android.bundle").toPath(),tamper);
    reset(); check(DreamKeyUpdateStore.selectBundle(context)==null,"corrupt last-good returns embedded bundle");
    context.pm.installed.versionCode=2; reset();
    check(DreamKeyUpdateStore.selectBundle(context)==null,"new native APK cannot load prior native patches");
    // Exercise the actual pre-install checks with public synthetic package metadata.
    DreamKeyUpdateStore apkStore=DreamKeyUpdateStore.get(context);
    Method apk=DreamKeyUpdateStore.class.getDeclaredMethod("verifyApk",File.class,String.class);apk.setAccessible(true);
    context.pm.archive.versionCode=3;context.pm.archive.versionName="1.0.1";
    apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1");checks++;
    context.pm.archive.packageName="com.attacker.wallet";
    reject("APK package mismatch",()->apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1"));
    context.pm.archive.packageName="com.dreamkey.wallet";context.pm.archive.versionName="1.0.2";
    reject("APK target version mismatch",()->apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1"));
    context.pm.archive.versionName="1.0.1";context.pm.archive.versionCode=2;
    reject("APK version code not increasing",()->apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1"));
    context.pm.archive.versionCode=3;
    context.pm.archive.signingInfo=new android.content.pm.SigningInfo(){@Override public android.content.pm.Signature[] getApkContentsSigners(){return new android.content.pm.Signature[]{new android.content.pm.Signature("other-certificate")};}};
    reject("APK certificate mismatch",()->apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1"));
    context.pm.archive.signingInfo=new android.content.pm.SigningInfo();context.pm.archive.applicationInfo.minSdkVersion=99;
    reject("APK Android API incompatibility",()->apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1"));
    context.pm.archive.applicationInfo.minSdkVersion=24;context.pm.archive=null;
    reject("invalid APK archive",()->apk.invoke(apkStore,new File(base,"fixture.apk"),"1.0.1"));
    verifyApkCommit(apkStore);
    verifyControlQueue();
    if(args.length>1){
      File realDirectory=fresh();
      DreamKeyUpdateVerifier.extract(context,new File(args[1]),realDirectory,"1.0.1",Integer.MAX_VALUE);
      DreamKeyUpdateVerifier.verifyDirectory(context,realDirectory,"1.0.1",Integer.MAX_VALUE);checks++;
    }
    System.out.println("Android native updates verified: " + checks + " real-JVM checks (ZIP manifest/hashes, HTTPS guards, cancellation, orphan recovery, launch control queue, rollback acknowledgement, APK identity/native isolation). No device or release secrets accessed.");
  }

  static void verifyApkCommit(DreamKeyUpdateStore store)throws Exception{
    Method commit=DreamKeyUpdateStore.class.getDeclaredMethod("commitApk",File.class,String.class);commit.setAccessible(true);
    Method apk=DreamKeyUpdateStore.class.getDeclaredMethod("apk");apk.setAccessible(true);
    Field version=DreamKeyUpdateStore.class.getDeclaredField("apkVersion");version.setAccessible(true);
    File directory=new File(context.base,"cache/updates/apk");directory.mkdirs();
    File old=new File(directory,"dreamkey-update.apk");Files.write(old.toPath(),new byte[]{1,2,3});
    version.set(store,"1.0.1");
    File temporary=new File(directory,"download.apk.part");Files.write(temporary.toPath(),new byte[]{4,5,6});
    android.util.AtomicFile.failWrites=true;
    try{reject("APK state commit disk failure",()->commit.invoke(store,temporary,"1.0.2"));}
    finally{android.util.AtomicFile.failWrites=false;}
    check(old.isFile()&&old.equals(apk.invoke(store))&&"1.0.1".equals(version.get(store)),"failed APK commit preserves previous file and in-memory pointer");
    Files.write(temporary.toPath(),new byte[]{4,5,6});
    commit.invoke(store,temporary,"1.0.2");
    File saved=(File)apk.invoke(store);
    check(saved.isFile()&&!saved.equals(old)&&!old.exists()&&"1.0.2".equals(version.get(store)),"successful APK commit switches immutable file after durable state");
    reset();
    check(saved.equals(apk.invoke(DreamKeyUpdateStore.get(context))),"committed APK file pointer survives process restart");
    DreamKeyUpdateStore restored=DreamKeyUpdateStore.get(context);
    Field protectedFiles=DreamKeyUpdateStore.class.getDeclaredField("installerFiles");protectedFiles.setAccessible(true);
    @SuppressWarnings("unchecked") java.util.Set<String> handedToInstaller=(java.util.Set<String>)protectedFiles.get(restored);
    handedToInstaller.add(saved.getName());
    Files.write(temporary.toPath(),new byte[]{7,8,9});
    commit.invoke(restored,temporary,"1.0.3");
    check(saved.isFile(),"new APK cache commit preserves file already handed to system installer");
  }

  static void verifyControlQueue()throws Exception{
    DreamKeyUpdatesModule module=new DreamKeyUpdatesModule(new com.facebook.react.bridge.ReactApplicationContext(new File(base,"bridge")));
    Field executorField=DreamKeyUpdatesModule.class.getDeclaredField("executor");executorField.setAccessible(true);
    java.util.concurrent.ExecutorService downloads=(java.util.concurrent.ExecutorService)executorField.get(module);
    java.util.concurrent.CountDownLatch started=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1);
    downloads.execute(()->{started.countDown();try{release.await();}catch(InterruptedException ignored){Thread.currentThread().interrupt();}});
    check(started.await(3,java.util.concurrent.TimeUnit.SECONDS),"fixture download worker is blocked");
    final class TestPromise implements com.facebook.react.bridge.Promise{
      java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);String error;
      public void resolve(Object value){done.countDown();}
      public void reject(String code,String message){error=code;done.countDown();}
      public void reject(String code,String message,Throwable cause){reject(code,message);}
      void succeeded(String description)throws Exception{check(done.await(3,java.util.concurrent.TimeUnit.SECONDS)&&error==null,description);}
    }
    try{
      TestPromise state=new TestPromise();module.getState(state);state.succeeded("state read is independent of an in-progress download");
      TestPromise confirmed=new TestPromise();module.markLaunchSuccessful(confirmed);confirmed.succeeded("launch confirmation cannot queue behind APK download");
    }finally{release.countDown();module.invalidate();}
  }

  static File makeZip(int version,String prefix,Map<String,byte[]> payload,Map<String,byte[]> extras) throws Exception {
    JSONObject manifest=new JSONObject().put("schemaVersion",1).put("platform","android").put("appVersion","1.0.0")
        .put("bundleVersion",version).put("entryFile","index.android.bundle");
    JSONArray files=new JSONArray();
    for(Map.Entry<String,byte[]> item:payload.entrySet()) files.put(new JSONObject().put("path",item.getKey())
        .put("sha256",hex(MessageDigest.getInstance("SHA-256").digest(item.getValue()))).put("size",item.getValue().length));
    manifest.put("files",files);
    byte[] json=manifest.toString().getBytes(StandardCharsets.UTF_8);
    File zip=new File(base,"fixture-"+(++fixtures)+".zip");
    try(ZipOutputStream out=new ZipOutputStream(Files.newOutputStream(zip.toPath()))){
      entry(out,prefix+"manifest.json",json);
      for(Map.Entry<String,byte[]> item:payload.entrySet())entry(out,prefix+item.getKey(),item.getValue());
      if(extras!=null)for(Map.Entry<String,byte[]> item:extras.entrySet())entry(out,item.getKey(),item.getValue());
    }
    return zip;
  }
  static void entry(ZipOutputStream out,String name,byte[] bytes)throws Exception{out.putNextEntry(new ZipEntry(name));out.write(bytes);out.closeEntry();}
  static File fresh(){File file=new File(base,"extract-"+(++fixtures));file.mkdirs();return file;}
  static File extract(File zip,int version)throws Exception{File destination=fresh();DreamKeyUpdateVerifier.extract(context,zip,destination,"1.0.0",version);return destination;}
  static void release(File root,int version,Map<String,byte[]> payload)throws Exception{
    File destination=new File(root,"bundle-"+version);destination.mkdirs();DreamKeyUpdateVerifier.extract(context,makeZip(version,"",payload,null),destination,"1.0.0",version);
  }
  static void state(File root,int active,int pending,int attempting,int highest)throws Exception{
    JSONObject json=new JSONObject().put("appVersion","1.0.0").put("active",active).put("pending",pending).put("attempting",attempting).put("highest",highest).put("failed",0);
    Files.write(new File(root,"state.json").toPath(),json.toString().getBytes(StandardCharsets.UTF_8));
  }
  static void reset()throws Exception{Field field=DreamKeyUpdateStore.class.getDeclaredField("instance");field.setAccessible(true);field.set(null,null);}
  static void reject(String description,Throwing task)throws Exception{try{task.run();}catch(Exception expected){checks++;return;}throw new AssertionError("Must reject "+description);}
  static void check(boolean value,String description){if(!value)throw new AssertionError(description);checks++;}
  static boolean isBundle(String path,int version){return path!=null && path.replace('\\','/').endsWith("bundle-"+version+"/index.android.bundle");}
  static void replace(byte[] bytes,String old,String replacement){byte[] from=old.getBytes(StandardCharsets.US_ASCII),to=replacement.getBytes(StandardCharsets.US_ASCII);if(from.length!=to.length)throw new AssertionError("Fixture replacement length");for(int i=0;i<=bytes.length-from.length;i++){boolean match=true;for(int j=0;j<from.length;j++)if(bytes[i+j]!=from[j]){match=false;break;}if(match){System.arraycopy(to,0,bytes,i,to.length);i+=from.length-1;}}}
  static String hex(byte[] bytes){StringBuilder result=new StringBuilder();for(byte item:bytes)result.append(String.format("%02x",item&255));return result.toString();}
}
