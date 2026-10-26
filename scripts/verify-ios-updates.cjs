/* Compiles and executes the real iOS update verifier/store on macOS only.
 * React bridge declarations and the app version/storage location are isolated
 * fixtures. No device, installed app, wallet data, network, or signing material.
 * Windows runs integration wiring checks and explicitly skips native execution.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {packageWithManifest, zipStore} = require('./update-tools.cjs');

const repo = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(repo, 'ios/IndependentWallet/DreamKeyUpdates.mm'), 'utf8');
const delegate = fs.readFileSync(path.join(repo, 'ios/IndependentWallet/AppDelegate.mm'), 'utf8');
const project = fs.readFileSync(path.join(repo, 'ios/IndependentWallet.xcodeproj/project.pbxproj'), 'utf8');
assert.match(delegate, /DreamKeyUpdatesBundleURL\(\)\s*\?:\s*\[\[NSBundle mainBundle\] URLForResource:@"main" withExtension:@"jsbundle"\]/,
  'Release AppDelegate must retain the embedded recovery bundle');
assert.match(project, /DreamKeyUpdates\.mm in Sources[^\r\n]*isa = PBXBuildFile/,
  'The native update bridge must be registered in the application target');
assert.match(original, /RCT_REMAP_METHOD\(acknowledgeRollback,/, 'The rollback acknowledgement must be exported to JS');

if (process.platform !== 'darwin') {
  console.log('iOS update integration wiring passed. SKIPPED: actual Objective-C++ compilation and native regression require macOS/Xcode; this is not an iOS build verification.');
  process.exit(0);
}

const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dreamkey-ios-update-test-'));
function write(name, content) {
  const filename = path.join(temporary, name);
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  fs.writeFileSync(filename, content);
  return filename;
}
function replaceFunction(source, signature, body) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0 && source.indexOf(signature, start + signature.length) < 0, `Expected one ${signature}`);
  const open = source.indexOf('{', start + signature.length);
  let close = open + 1;
  let depth = 1;
  while (close < source.length && depth) {
    if (source[close] === '{') depth++;
    if (source[close] === '}') depth--;
    close++;
  }
  assert.equal(depth, 0);
  return source.slice(0, open + 1) + '\n' + body + '\n' + source.slice(close - 1);
}

try {
  write('React/RCTBridgeModule.h', `#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
typedef void (^RCTPromiseResolveBlock)(id);
typedef void (^RCTPromiseRejectBlock)(NSString *,NSString *,NSError *);
@protocol RCTBridgeModule <NSObject>
@end
#define RCT_EXPORT_MODULE(...)
#define RCT_REMAP_METHOD(name, ...) - (void)__VA_ARGS__
`);
  write('React/RCTEventEmitter.h', `#import "RCTBridgeModule.h"
@interface RCTEventEmitter : NSObject
- (void)invalidate;
- (dispatch_queue_t)methodQueue;
- (void)sendEventWithName:(NSString *)name body:(id)body;
@end
`);
  write('DreamKeyUpdates.h', fs.readFileSync(path.join(repo, 'ios/IndependentWallet/DreamKeyUpdates.h')));
  let isolated = replaceFunction(original, 'static NSString *DKAppVersion(void)', '  return @"1.0.0";');
  isolated = replaceFunction(isolated, 'static NSString *DKNativeBuild(void)', '  return DKTestNativeBuild;');
  isolated = replaceFunction(isolated, 'static NSURL *DKRoot(void)', '  return [NSURL fileURLWithPath:NSProcessInfo.processInfo.environment[@"DK_UPDATE_TEST_ROOT"] isDirectory:YES];');
  write('IsolatedUpdates.mm', '#import <Foundation/Foundation.h>\nstatic NSString *DKTestNativeBuild = @"1";\n' + isolated);

  const payload = [
    {path: 'index.ios.bundle', data: Buffer.from('OFFLINE-TEST-BUNDLE-NOT-EXECUTED')},
    {path: 'assets/src/assets/logo.png', data: Buffer.from('OFFLINE-TEST-IMAGE')},
  ];
  for (const version of [1, 2, 3]) write(`patch-${version}.zip`, zipStore(packageWithManifest(payload, 'ios', '1.0.0', version)));
  write('wrong-platform.zip', zipStore(packageWithManifest([{path: 'index.android.bundle', data: Buffer.from('fixture')}], 'android', '1.0.0', 4)));
  write('wrong-app.zip', zipStore(packageWithManifest(payload, 'ios', '9.0.0', 4)));
  write('traversal.zip', zipStore([{path: 'manifest.json', data: Buffer.from('{}')}, {path: '../escape', data: Buffer.from('fixture')} ]));
  const good = zipStore(packageWithManifest(payload, 'ios', '1.0.0', 4));
  write('trailing.zip', Buffer.concat([good, Buffer.from('hidden')]));
  write('truncated.zip', good.subarray(0, good.length - 7));
  const tampered = Buffer.from(good);
  const textOffset = tampered.indexOf(payload[1].data);
  assert.ok(textOffset > 0);
  tampered[textOffset] ^= 1;
  write('tampered.zip', tampered);

  const harness = write('NativeUpdateRegression.mm', `#import "React/RCTEventEmitter.h"
@implementation RCTEventEmitter
- (void)invalidate {}
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (void)sendEventWithName:(NSString *)name body:(id)body {}
@end
#import "IsolatedUpdates.mm"

static void Check(BOOL valid, NSString *message) {
  if (!valid) { NSLog(@"FAIL: %@",message); exit(1); }
}
static NSData *Archive(NSString *name) {
  return [NSData dataWithContentsOfURL:[[NSURL fileURLWithPath:NSProcessInfo.processInfo.environment[@"DK_UPDATE_TEST_FILES"]] URLByAppendingPathComponent:name]];
}
static void Restart(void) { DKStartupSelected = NO; DKSelectedVersion = 0; DKSelectedURL = nil; }
static void Reset(void) {
  [[NSFileManager defaultManager] removeItemAtURL:DKRoot() error:nil];
  Restart();
}
static BOOL Stage(NSString *archive, NSInteger version) {
  NSError *error = nil;
  return DKStageArchive(Archive(archive),@"1.0.0",version,&error);
}
static NSDictionary *ReadBridge(DreamKeyUpdates *bridge) {
  __block NSDictionary *result = nil;
  [bridge getStateWithResolver:^(id value) { result = value; } rejecter:^(NSString *code,NSString *message,NSError *error) { Check(NO,message); }];
  Check(result != nil,@"getState must resolve");
  return result;
}
static void Confirm(DreamKeyUpdates *bridge) {
  __block BOOL done = NO;
  [bridge markLaunchSuccessfulWithResolver:^(id value) { done = YES; } rejecter:^(NSString *code,NSString *message,NSError *error) { Check(NO,message); }];
  Check(done,@"launch confirmation must resolve");
}

int main(void) { @autoreleasepool {
  NSString *temporaryRoot = [[NSURL fileURLWithPath:NSTemporaryDirectory()] URLByResolvingSymlinksInPath].path;
  Check([DKRoot().path hasPrefix:[temporaryRoot stringByAppendingString:@"/"]],@"fixture storage must be inside the system temporary directory");
  DreamKeyUpdates *bridge = [DreamKeyUpdates new];
  Reset();
  Check(Stage(@"patch-1.zip",1),@"stage first compatible patch");
  Check([DKReadState()[@"pending"] integerValue] == 1,@"stage must commit pending state");
  NSURL *first = DreamKeyUpdatesBundleURL();
  Check(first != nil && [first.lastPathComponent isEqual:@"index.ios.bundle"],@"select staged iOS bundle");
  Check([[NSFileManager defaultManager] fileExistsAtPath:[[first URLByDeletingLastPathComponent] URLByAppendingPathComponent:@"assets/src/assets/logo.png"].path],@"Metro assets must stay next to the active bundle");
  Check(DreamKeyUpdatesBundleURL() == first,@"multiple AppDelegate URL requests must keep the same launch selection");
  Check([DKReadState()[@"attempting"] integerValue] == 1,@"attempt marker is durable before JS executes");
  Confirm(bridge);
  Check([DKReadState()[@"lastGood"] integerValue] == 1 && [DKReadState()[@"attempting"] integerValue] == 0,@"confirmation commits the last working version");

  Check(Stage(@"patch-2.zip",2),@"stage next patch without changing the running bundle");
  Check([ReadBridge(bridge)[@"bundleVersion"] integerValue] == 1,@"staging must not change running version");
  Restart();
  Check(DreamKeyUpdatesBundleURL() != nil && DKSelectedVersion == 2,@"pending patch is selected after restart");
  Check(!Stage(@"patch-3.zip",3),@"unconfirmed launch must reject another stage");
  Restart();
  Check(DreamKeyUpdatesBundleURL() != nil && DKSelectedVersion == 1,@"failed launch rolls back to confirmed patch");
  Check([ReadBridge(bridge)[@"rollback"] boolValue] && [ReadBridge(bridge)[@"rollback"] boolValue],@"About or a second read cannot consume the rollback notice");
  Check([ReadBridge(bridge)[@"failedBundleVersion"] integerValue] == 2,@"failed version is exposed");
  __block BOOL acknowledged = NO;
  [bridge acknowledgeRollbackWithResolver:^(id value) { acknowledged = YES; } rejecter:^(NSString *code,NSString *message,NSError *error) { Check(NO,message); }];
  Check(acknowledged && ![ReadBridge(bridge)[@"rollback"] boolValue],@"only explicit acknowledgement clears the notice");
  Check(!Stage(@"patch-2.zip",2),@"failed patch cannot be downloaded again");
  NSMutableDictionary *old = DKReadState();
  [old removeObjectForKey:@"highest"];
  NSError *failure = nil;
  Check(DKWriteState(old,&failure),@"persist old state fixture");
  Check([DKReadState()[@"highest"] integerValue] == 2 && !Stage(@"patch-2.zip",2),@"legacy state preserves the highest attempted patch");

  for (NSString *bad in @[@"wrong-platform.zip",@"wrong-app.zip",@"traversal.zip",@"trailing.zip",@"truncated.zip",@"tampered.zip"]) {
    Check(!Stage(bad,4),[@"reject malformed or incompatible archive: " stringByAppendingString:bad]);
    Check([DKReadState()[@"active"] integerValue] == 1 && [DKReadState()[@"highest"] integerValue] == 2,@"rejected archives preserve the working state");
  }

  Check(Stage(@"patch-3.zip",3),@"a higher valid patch remains installable after rejection");
  Restart();
  Check(DreamKeyUpdatesBundleURL() != nil && DKSelectedVersion == 3,@"select higher patch");
  Confirm(bridge);
  NSURL *asset = [DKVersionDirectory(3) URLByAppendingPathComponent:@"assets/src/assets/logo.png"];
  Check([@"tampered" writeToURL:asset atomically:YES encoding:NSUTF8StringEncoding error:&failure],@"tamper test fixture");
  Restart();
  Check(DreamKeyUpdatesBundleURL() == nil && DKSelectedVersion == 0,@"changed installed assets fall back to the embedded bundle");

  DKTestNativeBuild = @"2";
  Restart();
  Check(DreamKeyUpdatesBundleURL() == nil && [ReadBridge(bridge)[@"highestBundleVersion"] integerValue] == 0,@"new native build starts with patch zero and no old compatibility state");
  Check(Stage(@"patch-1.zip",1),@"new native compatibility domain can stage its own patch");
  Check(![DKVersionDirectory(1).path isEqual:first.URLByDeletingLastPathComponent.path],@"native builds have separate on-disk patch directories");

  Reset();
  Check(DKPrepareRoot(&failure),@"create isolated root");
  Check([[NSFileManager defaultManager] createDirectoryAtURL:[DKRoot() URLByAppendingPathComponent:@"state.json"] withIntermediateDirectories:NO attributes:nil error:&failure],@"create atomic state save fault");
  Check(!Stage(@"patch-1.zip",1),@"failed state commit must reject stage");
  Check(![[NSFileManager defaultManager] fileExistsAtPath:DKVersionDirectory(1).path],@"failed state commit removes promoted orphan directory");
  Reset();

  DreamKeyUpdates *invalid = [DreamKeyUpdates new];
  [invalid invalidate];
  __block NSString *code = nil;
  [invalid stageBundle:@"https://updates.example.com/patch.zip" appVersion:@"1.0.0" bundleVersion:@1 resolver:^(id value) { Check(NO,@"invalidated bridge cannot start a download"); } rejecter:^(NSString *value,NSString *message,NSError *error) { code = value; }];
  Check([code isEqual:@"E_UPDATE_NATIVE"] && invalid.download == nil,@"invalidated bridge cannot create a network session");
  NSLog(@"iOS real native OTA regression passed: compatible staging, manifest/hash/ZIP rejection, durable launch attempt, confirmation/rollback, explicit acknowledgement, legacy monotonic state, asset path, native-build isolation, atomic-save cleanup and invalidation.");
  return 0;
} }
`);
  const compiler = cp.execFileSync('xcrun', ['--find', 'clang++'], {encoding: 'utf8'}).trim();
  const executable = path.join(temporary, 'native-update-regression');
  cp.execFileSync(compiler, ['-fobjc-arc', '-fblocks', '-std=c++20', '-DDEBUG=0', '-I', temporary, '-framework', 'Foundation', harness, '-o', executable], {stdio: 'inherit'});
  cp.execFileSync(executable, [], {stdio: 'inherit', env: {...process.env, DK_UPDATE_TEST_ROOT: path.join(temporary, 'storage'), DK_UPDATE_TEST_FILES: temporary}});
} finally {
  // Delete only the unique fixture directory created above, never an app path.
  assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('dreamkey-ios-update-test-'));
  fs.rmSync(temporary, {recursive: true, force: true});
}
