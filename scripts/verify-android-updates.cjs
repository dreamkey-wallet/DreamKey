/* Executes the real Android verifier/store on an isolated JVM with minimal OS stubs.
 * No device, wallet data, installed app, or release signing material is accessed. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamkey-native-update-test-'));
const javaHome = process.env.JAVA_HOME || '';
const javac = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac') : 'javac';
const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const jsonRoot = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1/org.json/json');
function findJar(directory) {
  if (!fs.existsSync(directory)) return undefined;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && /^json-.*\.jar$/.test(entry.name)) return file;
    if (entry.isDirectory()) { const found = findJar(file); if (found) return found; }
  }
}
const jsonJar = process.env.UPDATE_TEST_JSON_JAR || findJar(jsonRoot);
if (!jsonJar) throw new Error('Set UPDATE_TEST_JSON_JAR to an org.json JVM jar (available after the Android Gradle build).');
function write(name, content) {
  const file = path.join(temp, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
}
const sources = [];
function stub(name, content) { sources.push(write(name, content)); }
stub('android/annotation/SuppressLint.java', `package android.annotation; public @interface SuppressLint {String[] value();}`);
stub('android/content/Context.java', `package android.content;
public class Context { public java.io.File base; public byte[] key; public android.content.pm.PackageManager pm=new android.content.pm.PackageManager();
 public Context(java.io.File dir,byte[] pem){base=dir;key=pem;} public Context getApplicationContext(){return this;}
 public String getPackageName(){return "com.dreamkey.wallet";} public android.content.pm.PackageManager getPackageManager(){return pm;}
 public java.io.File getNoBackupFilesDir(){return base;} public java.io.File getCacheDir(){return new java.io.File(base,"cache");}
 public void startActivity(Intent intent){} public android.content.res.Resources getResources(){return new android.content.res.Resources(key);} }
`);
stub('android/content/res/Resources.java', `package android.content.res; public class Resources { byte[] key; public Resources(byte[] k){key=k;} public java.io.InputStream openRawResource(int id){return new java.io.ByteArrayInputStream(key);} }`);
stub('android/util/Base64.java', `package android.util; public class Base64 { public static final int NO_WRAP=2; public static byte[] decode(String s,int f){return java.util.Base64.getDecoder().decode(s);} }`);
stub('android/util/AtomicFile.java', `package android.util; public class AtomicFile { public static boolean failWrites=false; java.io.File file; public AtomicFile(java.io.File f){file=f;} public java.io.FileInputStream openRead() throws Exception{return new java.io.FileInputStream(file);}
 public java.io.FileOutputStream startWrite() throws Exception{if(failWrites)throw new java.io.IOException("fixture full storage");return new java.io.FileOutputStream(new java.io.File(file+".new"));}
 public void finishWrite(java.io.FileOutputStream out) throws Exception {out.getFD().sync();out.close();java.nio.file.Files.move(new java.io.File(file+".new").toPath(),file.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);}
 public void failWrite(java.io.FileOutputStream out){try{out.close();}catch(Exception e){}new java.io.File(file+".new").delete();} }
`);
stub('android/os/Build.java', `package android.os; public class Build { public static class VERSION {public static int SDK_INT=35;} public static class VERSION_CODES {public static final int O=26,P=28;} }`);
stub('android/content/pm/PackageInfo.java', `package android.content.pm; public class PackageInfo { public String versionName="1.0.0",packageName="com.dreamkey.wallet"; public int versionCode=1; public ApplicationInfo applicationInfo=new ApplicationInfo(); public SigningInfo signingInfo=new SigningInfo(); public Signature[] signatures={new Signature()}; public long getLongVersionCode(){return versionCode;} }`);
stub('android/content/pm/ApplicationInfo.java', `package android.content.pm; public class ApplicationInfo {public int minSdkVersion=24;}`);
stub('android/content/pm/SigningInfo.java', `package android.content.pm; public class SigningInfo {public Signature[] getApkContentsSigners(){return new Signature[]{new Signature()};}}`);
stub('android/content/pm/Signature.java', `package android.content.pm; public class Signature {public String value="test-certificate";public Signature(){}public Signature(String s){value=s;}public String toCharsString(){return value;}}`);
stub('android/content/pm/PackageManager.java', `package android.content.pm; public class PackageManager {public static final int GET_SIGNING_CERTIFICATES=1,GET_SIGNATURES=2; public PackageInfo installed=new PackageInfo(),archive=new PackageInfo(); public PackageInfo getPackageInfo(String p,int f){return installed;} public PackageInfo getPackageArchiveInfo(String p,int f){return archive;} public boolean canRequestPackageInstalls(){return true;}}`);
stub('android/net/Uri.java', `package android.net; public class Uri {public static Uri parse(String value){return new Uri();}}`);
stub('android/provider/Settings.java', `package android.provider; public class Settings {public static final String ACTION_MANAGE_UNKNOWN_APP_SOURCES="permission";}`);
stub('android/content/ClipData.java', `package android.content; public class ClipData {public static ClipData newRawUri(String name,android.net.Uri uri){return new ClipData();}}`);
stub('android/content/Intent.java', `package android.content; public class Intent {public static final String ACTION_VIEW="view";public static final int FLAG_GRANT_READ_URI_PERMISSION=1,FLAG_ACTIVITY_NEW_TASK=2; public Intent(String s){} public Intent(String s,android.net.Uri u){} public Intent addFlags(int f){return this;}public Intent setDataAndType(android.net.Uri u,String t){return this;}public void setClipData(ClipData data){} }`);
stub('androidx/core/content/FileProvider.java', `package androidx.core.content; public class FileProvider {public static android.net.Uri getUriForFile(android.content.Context c,String s,java.io.File f){return new android.net.Uri();}}`);
stub('com/dreamkey/wallet/R.java', `package com.dreamkey.wallet; public class R {public static class raw {public static final int dreamkey_update_public_key=1;}}`);
stub('com/dreamkey/wallet/BuildConfig.java', `package com.dreamkey.wallet; public class BuildConfig {public static final boolean DEBUG=false;}`);
stub('com/facebook/react/bridge/ReactApplicationContext.java', `package com.facebook.react.bridge; public class ReactApplicationContext extends android.content.Context {public ReactApplicationContext(java.io.File dir){super(dir,new byte[0]);} public boolean hasActiveReactInstance(){return true;} public <T>T getJSModule(Class<T> type){return null;}}`);
stub('com/facebook/react/bridge/ReactContextBaseJavaModule.java', `package com.facebook.react.bridge; public abstract class ReactContextBaseJavaModule {private final ReactApplicationContext context;public ReactContextBaseJavaModule(ReactApplicationContext c){context=c;} public ReactApplicationContext getReactApplicationContext(){return context;}public abstract String getName();public void invalidate(){}}`);
stub('com/facebook/react/bridge/Promise.java', `package com.facebook.react.bridge; public interface Promise {void resolve(Object value);void reject(String code,String message);void reject(String code,String message,Throwable error);}`);
stub('com/facebook/react/bridge/ReactMethod.java', `package com.facebook.react.bridge; public @interface ReactMethod {}`);
stub('com/facebook/react/bridge/WritableMap.java', `package com.facebook.react.bridge; public class WritableMap {public void putBoolean(String key,boolean value){}public void putDouble(String key,double value){}public void putString(String key,String value){}}`);
stub('com/facebook/react/bridge/Arguments.java', `package com.facebook.react.bridge; public class Arguments {public static WritableMap createMap(){return new WritableMap();}}`);
stub('com/facebook/react/bridge/UiThreadUtil.java', `package com.facebook.react.bridge; public class UiThreadUtil {public static void runOnUiThread(Runnable task){task.run();}}`);
stub('com/facebook/react/modules/core/DeviceEventManagerModule.java', `package com.facebook.react.modules.core; public class DeviceEventManagerModule {public interface RCTDeviceEventEmitter {void emit(String name,com.facebook.react.bridge.WritableMap payload);}}`);
for (const name of ['DreamKeyUpdateDownload', 'DreamKeyUpdateVerifier', 'DreamKeyUpdateStore', 'DreamKeyUpdateException', 'DreamKeyUpdatesModule']) {
  sources.push(path.join(repo, 'android/app/src/main/java/com/dreamkey/wallet', `${name}.java`));
}
sources.push(path.join(__dirname, 'fixtures/AndroidUpdateVerification.java'));
try {
  const classes = path.join(temp, 'classes'); fs.mkdirSync(classes);
  cp.execFileSync(javac, ['-encoding', 'UTF-8', '-cp', jsonJar, '-d', classes, ...sources], { stdio: 'inherit' });
  cp.execFileSync(java, ['-cp', `${classes}${path.delimiter}${jsonJar}`, 'com.dreamkey.wallet.AndroidUpdateVerification', temp, ...(process.env.UPDATE_TEST_REAL_ZIP ? [path.resolve(process.env.UPDATE_TEST_REAL_ZIP)] : [])], { stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
