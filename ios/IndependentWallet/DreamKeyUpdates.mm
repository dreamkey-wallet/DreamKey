#import "DreamKeyUpdates.h"

#import <CommonCrypto/CommonDigest.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTBridgeModule.h>
#import <sys/stat.h>
#import <limits.h>
#import <math.h>
#import <string.h>

static const NSUInteger DKMaxZipSize = 50 * 1024 * 1024;
static const NSUInteger DKMaxExpandedSize = 150 * 1024 * 1024;
static const NSUInteger DKMaxEntries = 1000;
static const NSUInteger DKMaxManifestSize = 256 * 1024;
static NSInteger DKSelectedVersion = 0;
static BOOL DKStartupSelected = NO;
static NSURL *DKSelectedURL;

static NSError *DKError(NSString *message) {
  return [NSError errorWithDomain:@"DreamKeyUpdates" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *DKAppVersion(void) {
  return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"";
}

static NSString *DKNativeBuild(void) {
  return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"";
}

static NSString *DKNativeIdentity(void) {
  return [NSString stringWithFormat:@"%@:%@",DKAppVersion(),DKNativeBuild()];
}

static NSObject *DKLock(void) {
  static NSObject *lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ lock = [NSObject new]; });
  return lock;
}

static NSString *DKSHA256(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hash = [NSMutableString stringWithCapacity:64];
  for (NSUInteger i = 0; i < sizeof(digest); i++) [hash appendFormat:@"%02x", digest[i]];
  return hash;
}

static BOOL DKValidPath(NSString *path) {
  if (![path isKindOfClass:NSString.class] || path.length == 0 || path.length > 240) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./@+"] invertedSet];
  if ([path rangeOfCharacterFromSet:invalid].location != NSNotFound) return NO;
  for (NSString *component in [path componentsSeparatedByString:@"/"]) {
    if (!component.length || [component isEqual:@"."] || [component isEqual:@".."]) return NO;
  }
  return YES;
}

static BOOL DKPositiveInteger(id value) {
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  return isfinite(number) && number >= 1 && number <= INT32_MAX && floor(number) == number;
}

static NSURL *DKRoot(void) {
  NSURL *support = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
  return [support URLByAppendingPathComponent:@"DreamKeyUpdates" isDirectory:YES];
}

static BOOL DKPrepareRoot(NSError **error) {
  NSURL *root = DKRoot();
  if (!root || ![[NSFileManager defaultManager] createDirectoryAtURL:root withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:error]) return NO;
  return [root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:error];
}

static NSURL *DKVersionDirectory(NSInteger version) {
  NSString *native = DKSHA256([DKNativeIdentity() dataUsingEncoding:NSUTF8StringEncoding]);
  NSURL *versions = [[DKRoot() URLByAppendingPathComponent:@"versions" isDirectory:YES] URLByAppendingPathComponent:native isDirectory:YES];
  return [versions URLByAppendingPathComponent:[NSString stringWithFormat:@"%ld", (long)version] isDirectory:YES];
}

static NSMutableDictionary *DKReadState(void) {
  NSData *bytes = [NSData dataWithContentsOfURL:[DKRoot() URLByAppendingPathComponent:@"state.json"] options:0 error:nil];
  id value = bytes.length <= 16384 ? [NSJSONSerialization JSONObjectWithData:bytes ?: [NSData data] options:NSJSONReadingMutableContainers error:nil] : nil;
  NSMutableDictionary *state = [value isKindOfClass:NSMutableDictionary.class] ? value : [NSMutableDictionary dictionary];
  if (![state[@"appVersion"] isEqual:DKAppVersion()] || ![state[@"nativeBuild"] isEqual:DKNativeBuild()]) {
    state = [@{@"appVersion":DKAppVersion(), @"nativeBuild":DKNativeBuild(), @"active":@0, @"lastGood":@0, @"pending":@0, @"attempting":@0, @"highest":@0, @"failed":@0, @"rollback":@NO} mutableCopy];
  }
  for (NSString *key in @[@"active", @"lastGood", @"pending", @"attempting", @"highest", @"failed"]) {
    id number = state[key];
    if (![number isEqual:@0] && !DKPositiveInteger(number)) state[key] = @0;
  }
  // A partially migrated state must never reopen an already attempted version.
  // The markers are also useful recovery evidence when an older state omitted
  // highest, so normalize the monotonic floor before making any update decision.
  NSInteger highest = [state[@"highest"] integerValue];
  for (NSString *key in @[@"active", @"lastGood", @"pending", @"attempting", @"failed"]) {
    highest = MAX(highest,[state[key] integerValue]);
  }
  state[@"highest"] = @(highest);
  if (![state[@"rollback"] isKindOfClass:NSNumber.class]) state[@"rollback"] = @NO;
  return state;
}

static BOOL DKWriteState(NSDictionary *state, NSError **error) {
  if (!DKPrepareRoot(error)) return NO;
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:state options:0 error:error];
  return bytes && [bytes writeToURL:[DKRoot() URLByAppendingPathComponent:@"state.json"] options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:error];
}

static void DKCleanup(NSDictionary *state) {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *versions = [DKRoot() URLByAppendingPathComponent:@"versions" isDirectory:YES];
  NSString *currentNative = DKSHA256([DKNativeIdentity() dataUsingEncoding:NSUTF8StringEncoding]);
  NSMutableSet *keep = [NSMutableSet set];
  for (NSString *key in @[@"active",@"lastGood",@"pending",@"attempting"]) {
    NSInteger version = [state[key] integerValue];
    if (version > 0) [keep addObject:[NSString stringWithFormat:@"%ld",(long)version]];
  }
  for (NSURL *native in [manager contentsOfDirectoryAtURL:versions includingPropertiesForKeys:@[NSURLIsSymbolicLinkKey] options:0 error:nil]) {
    NSNumber *link = nil;
    [native getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
    if (![native.lastPathComponent isEqual:currentNative] || link.boolValue) { [manager removeItemAtURL:native error:nil]; continue; }
    for (NSURL *version in [manager contentsOfDirectoryAtURL:native includingPropertiesForKeys:nil options:0 error:nil]) {
      if (![keep containsObject:version.lastPathComponent]) [manager removeItemAtURL:version error:nil];
    }
  }
  for (NSURL *url in [manager contentsOfDirectoryAtURL:DKRoot() includingPropertiesForKeys:nil options:0 error:nil]) {
    if ([url.lastPathComponent hasPrefix:@"staging-"]) [manager removeItemAtURL:url error:nil];
  }
}

static BOOL DKSupported(void) {
#if DEBUG
  return NO;
#else
  return YES;
#endif
}

static NSDictionary *DKVerifyManifest(NSData *bytes, NSString *appVersion, NSInteger version, NSError **error) {
  if (!bytes.length || bytes.length > DKMaxManifestSize) { *error = DKError(@"Invalid update manifest size."); return nil; }
  id manifest = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:error];
  if (![manifest isKindOfClass:NSDictionary.class] || !DKPositiveInteger(manifest[@"schemaVersion"]) || [manifest[@"schemaVersion"] integerValue] != 1 || ![manifest[@"platform"] isEqual:@"ios"] || ![manifest[@"appVersion"] isEqual:appVersion] || !DKPositiveInteger(manifest[@"bundleVersion"]) || [manifest[@"bundleVersion"] integerValue] != version || ![manifest[@"entryFile"] isEqual:@"index.ios.bundle"] || ![manifest[@"files"] isKindOfClass:NSArray.class]) {
    *error = DKError(@"Update is incompatible with this application."); return nil;
  }
  NSArray *files = manifest[@"files"];
  if (!files.count || files.count > DKMaxEntries - 1) { *error = DKError(@"Invalid update file count."); return nil; }
  NSMutableSet *paths = [NSMutableSet set];
  NSUInteger total = 0;
  BOOL hasEntry = NO;
  NSCharacterSet *invalidHash = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  for (id file in files) {
    if (![file isKindOfClass:NSDictionary.class]) { *error = DKError(@"Invalid update file."); return nil; }
    NSString *path = file[@"path"];
    NSString *hash = file[@"sha256"];
    id sizeValue = file[@"size"];
    BOOL validSize = [sizeValue isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)sizeValue) != CFBooleanGetTypeID() && [sizeValue doubleValue] >= 0 && [sizeValue doubleValue] <= DKMaxZipSize && floor([sizeValue doubleValue]) == [sizeValue doubleValue];
    if (!DKValidPath(path) || [path isEqual:@"manifest.json"] || [path isEqual:@"manifest.sig"] || [paths containsObject:path.lowercaseString] || ![hash isKindOfClass:NSString.class] || hash.length != 64 || [hash rangeOfCharacterFromSet:invalidHash].location != NSNotFound || !validSize) { *error = DKError(@"Invalid update file metadata."); return nil; }
    [paths addObject:path.lowercaseString];
    total += [sizeValue unsignedIntegerValue];
    if (total > DKMaxExpandedSize) { *error = DKError(@"Update is too large."); return nil; }
    if ([path isEqual:@"index.ios.bundle"] && [sizeValue unsignedIntegerValue] > 0) hasEntry = YES;
  }
  if (!hasEntry) { *error = DKError(@"Update has no entry bundle."); return nil; }
  return manifest;
}

static uint16_t DKU16(const uint8_t *bytes, NSUInteger offset) { return (uint16_t)(bytes[offset] | bytes[offset + 1] << 8); }
static uint32_t DKU32(const uint8_t *bytes, NSUInteger offset) { return (uint32_t)bytes[offset] | (uint32_t)bytes[offset + 1] << 8 | (uint32_t)bytes[offset + 2] << 16 | (uint32_t)bytes[offset + 3] << 24; }

// Accept the publisher's minimal ZIP32 STORE format only. No ZIP64, encryption,
// descriptors, symlinks, directory entries, extras, comments, prefixes or trailing data.
static NSDictionary<NSString *, NSValue *> *DKParseZip(NSData *archive, NSError **error) {
  const uint8_t *bytes = (const uint8_t *)archive.bytes;
  NSUInteger length = archive.length;
  if (length < 22 || length > DKMaxZipSize) { *error = DKError(@"Invalid ZIP size."); return nil; }
  NSUInteger end = length - 22;
  if (DKU32(bytes,end) != 0x06054b50 || DKU16(bytes,end+4) || DKU16(bytes,end+6) || DKU16(bytes,end+20)) { *error = DKError(@"Unsupported ZIP format."); return nil; }
  NSUInteger count = DKU16(bytes,end+10), centralSize = DKU32(bytes,end+12), centralOffset = DKU32(bytes,end+16);
  if (count < 2 || count > DKMaxEntries || DKU16(bytes,end+8) != count || centralOffset > end || centralSize != end-centralOffset) { *error = DKError(@"Invalid ZIP directory."); return nil; }
  NSMutableDictionary *entries = [NSMutableDictionary dictionary];
  NSMutableSet *names = [NSMutableSet set];
  NSMutableArray<NSValue *> *segments = [NSMutableArray array];
  NSUInteger position = centralOffset, total = 0;
  for (NSUInteger index = 0; index < count; index++) {
    if (position > end || end-position < 46 || DKU32(bytes,position) != 0x02014b50) { *error = DKError(@"Invalid ZIP entry."); return nil; }
    NSUInteger flags = DKU16(bytes,position+8), method = DKU16(bytes,position+10), size = DKU32(bytes,position+24), compressed = DKU32(bytes,position+20), nameLength = DKU16(bytes,position+28), extra = DKU16(bytes,position+30), comment = DKU16(bytes,position+32), local = DKU32(bytes,position+42);
    uint32_t attributes = DKU32(bytes,position+38);
    NSUInteger fileType = (attributes >> 16) & S_IFMT;
    if ((flags & ~0x0800) || method || size != compressed || size > DKMaxZipSize || extra || comment || DKU16(bytes,position+34) || (fileType && fileType != S_IFREG) || (attributes & 0x10) || !nameLength || nameLength > 512 || nameLength > end-position-46 || local > centralOffset || centralOffset-local < 30) { *error = DKError(@"Unsafe or unsupported ZIP entry."); return nil; }
    NSString *name = [[NSString alloc] initWithBytes:bytes+position+46 length:nameLength encoding:NSUTF8StringEncoding];
    if (!DKValidPath(name) || [names containsObject:name.lowercaseString]) { *error = DKError(@"Unsafe or duplicate ZIP path."); return nil; }
    if (DKU32(bytes,local) != 0x04034b50 || DKU16(bytes,local+6) != flags || DKU16(bytes,local+8) != method || DKU32(bytes,local+14) != DKU32(bytes,position+16) || DKU32(bytes,local+18) != compressed || DKU32(bytes,local+22) != size || DKU16(bytes,local+26) != nameLength || DKU16(bytes,local+28) || nameLength > centralOffset-local-30) { *error = DKError(@"ZIP header mismatch."); return nil; }
    NSUInteger dataOffset = local+30+nameLength;
    if (size > centralOffset-dataOffset || memcmp(bytes+local+30,bytes+position+46,nameLength)) { *error = DKError(@"Invalid ZIP data range."); return nil; }
    total += size;
    if (total > DKMaxExpandedSize) { *error = DKError(@"Expanded ZIP is too large."); return nil; }
    entries[name] = [NSValue valueWithRange:NSMakeRange(dataOffset,size)];
    [names addObject:name.lowercaseString];
    [segments addObject:[NSValue valueWithRange:NSMakeRange(local,30+nameLength+size)]];
    position += 46+nameLength;
  }
  if (position != end) { *error = DKError(@"Unexpected ZIP directory data."); return nil; }
  [segments sortUsingComparator:^NSComparisonResult(NSValue *a, NSValue *b) { return a.rangeValue.location < b.rangeValue.location ? NSOrderedAscending : (a.rangeValue.location > b.rangeValue.location ? NSOrderedDescending : NSOrderedSame); }];
  NSUInteger next = 0;
  for (NSValue *segment in segments) {
    if (segment.rangeValue.location != next) { *error = DKError(@"Overlapping or hidden ZIP data."); return nil; }
    next = NSMaxRange(segment.rangeValue);
  }
  if (next != centralOffset) { *error = DKError(@"Unexpected ZIP payload data."); return nil; }
  return entries;
}

static NSData *DKArchiveFile(NSData *archive, NSDictionary<NSString *,NSValue *> *entries, NSString *name) {
  NSValue *range = entries[name];
  if (!range) return nil;
  NSRange slice = range.rangeValue;
  // Keep the bounded download alive without copying every asset during verification.
  // The deallocator captures archive so these bytes outlive the returned view.
  return [[NSData alloc] initWithBytesNoCopy:(void *)((const uint8_t *)archive.bytes+slice.location) length:slice.length deallocator:^(void *bytes, NSUInteger length) { (void)archive; }];
}

static BOOL DKVerifyDirectory(NSURL *directory, NSInteger version, NSError **error) {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSNumber *isDirectory = nil, *isLink = nil;
  if (![directory getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:error] || !isDirectory.boolValue || ![directory getResourceValue:&isLink forKey:NSURLIsSymbolicLinkKey error:error] || isLink.boolValue) return NO;
  NSURL *manifestURL = [directory URLByAppendingPathComponent:@"manifest.json"];
  NSURL *legacySignatureURL = [directory URLByAppendingPathComponent:@"manifest.sig"];
  NSDictionary *manifestAttributes = [manager attributesOfItemAtPath:manifestURL.path error:error];
  NSDictionary *legacySignatureAttributes = [manager attributesOfItemAtPath:legacySignatureURL.path error:nil];
  if (![manifestAttributes[NSFileType] isEqual:NSFileTypeRegular] || [manifestAttributes[NSFileSize] unsignedLongLongValue] > DKMaxManifestSize) { *error = DKError(@"Invalid installed update metadata."); return NO; }
  BOOL hasLegacySignature = legacySignatureAttributes != nil;
  if (hasLegacySignature && (![legacySignatureAttributes[NSFileType] isEqual:NSFileTypeRegular] || [legacySignatureAttributes[NSFileSize] unsignedLongLongValue] > 4096)) { *error = DKError(@"Invalid installed update metadata."); return NO; }
  NSDictionary *manifest = DKVerifyManifest([NSData dataWithContentsOfURL:manifestURL options:0 error:error], DKAppVersion(), version, error);
  if (!manifest) return NO;
  NSMutableSet *expected = [NSMutableSet setWithArray:@[@"manifest.json"]];
  if (hasLegacySignature) [expected addObject:@"manifest.sig"];
  NSMutableSet *directories = [NSMutableSet set];
  for (NSDictionary *file in manifest[@"files"]) {
    NSString *path = file[@"path"];
    [expected addObject:path];
    NSString *parent = path.stringByDeletingLastPathComponent;
    while (parent.length) { [directories addObject:parent]; parent = parent.stringByDeletingLastPathComponent; }
    NSURL *url = [directory URLByAppendingPathComponent:path];
    NSDictionary *attributes = [manager attributesOfItemAtPath:url.path error:error];
    if (![attributes[NSFileType] isEqual:NSFileTypeRegular] || ![attributes[NSFileSize] isEqual:file[@"size"]]) { *error = DKError(@"Installed update file changed."); return NO; }
    NSData *bytes = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:error];
    if (!bytes || ![DKSHA256(bytes) isEqual:file[@"sha256"]]) { *error = DKError(@"Installed update hash verification failed."); return NO; }
  }
  __block BOOL valid = YES;
  NSDirectoryEnumerator *enumerator = [manager enumeratorAtURL:directory includingPropertiesForKeys:@[NSURLIsSymbolicLinkKey,NSURLIsDirectoryKey,NSURLIsRegularFileKey] options:0 errorHandler:^BOOL(NSURL *url, NSError *failure) { valid = NO; return NO; }];
  NSUInteger fileCount = 0;
  for (NSURL *url in enumerator) {
    NSString *path = [url.path substringFromIndex:directory.path.length+1];
    NSNumber *link = nil, *folder = nil, *regular = nil;
    if (![url getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:error] || link.boolValue || ![url getResourceValue:&folder forKey:NSURLIsDirectoryKey error:error] || ![url getResourceValue:&regular forKey:NSURLIsRegularFileKey error:error]) { valid = NO; break; }
    if (folder.boolValue) { if (![directories containsObject:path]) { valid = NO; break; } }
    else if (!regular.boolValue || ![expected containsObject:path] || ++fileCount > DKMaxEntries) { valid = NO; break; }
  }
  if (!valid || fileCount != expected.count) { *error = DKError(@"Unexpected files in installed update."); return NO; }
  return YES;
}

NSURL *DreamKeyUpdatesBundleURL(void) {
  @synchronized(DKLock()) {
    if (DKStartupSelected) return DKSelectedURL;
    DKStartupSelected = YES;
    if (!DKSupported()) return nil;
    NSMutableDictionary *state = DKReadState();
    NSError *error = nil;
    if ([state[@"attempting"] integerValue] > 0) {
      state[@"failed"] = @(MAX([state[@"failed"] integerValue],[state[@"attempting"] integerValue]));
      state[@"active"] = state[@"lastGood"] ?: @0;
      state[@"attempting"] = @0;
      state[@"pending"] = @0;
      state[@"rollback"] = @YES;
    }
    NSInteger pending = [state[@"pending"] integerValue];
    if (pending > 0) {
      if (DKVerifyDirectory(DKVersionDirectory(pending), pending, &error)) {
        state[@"active"] = @(pending);
        state[@"attempting"] = @(pending);
        // A previous failed patch may have left the durable rollback notice set.
        // Selecting and verifying a new pending patch starts a fresh launch
        // attempt, so do not report the stale rollback on this launch.
        state[@"rollback"] = @NO;
      } else { state[@"rollback"] = @YES; state[@"failed"] = @(MAX([state[@"failed"] integerValue],pending)); }
      state[@"pending"] = @0;
    }
    NSInteger active = [state[@"active"] integerValue];
    if (active > 0 && !DKVerifyDirectory(DKVersionDirectory(active), active, &error)) {
      state[@"failed"] = @(MAX([state[@"failed"] integerValue],active));
      active = [state[@"lastGood"] integerValue];
      if (active > 0 && !DKVerifyDirectory(DKVersionDirectory(active), active, &error)) active = 0;
      state[@"active"] = @(active);
      state[@"attempting"] = @0;
      state[@"rollback"] = @YES;
    }
    if (!DKWriteState(state,&error)) return nil;
    DKCleanup(state);
    DKSelectedVersion = active;
    if (active > 0) DKSelectedURL = [DKVersionDirectory(active) URLByAppendingPathComponent:@"index.ios.bundle"];
    return DKSelectedURL;
  }
}

static BOOL DKStageArchive(NSData *archive, NSString *appVersion, NSInteger version, NSError **error) {
  NSDictionary<NSString *,NSValue *> *entries = DKParseZip(archive,error);
  if (!entries) return NO;
  NSDictionary *manifest = DKVerifyManifest(DKArchiveFile(archive,entries,@"manifest.json"), appVersion, version,error);
  NSUInteger expectedEntries = manifest ? [manifest[@"files"] count] + 1 : 0;
  if (!manifest || entries.count != expectedEntries) { if (!*error) *error = DKError(@"Unexpected files in update ZIP."); return NO; }
  for (NSDictionary *file in manifest[@"files"]) {
    NSData *bytes = DKArchiveFile(archive,entries,file[@"path"]);
    if (!bytes || bytes.length != [file[@"size"] unsignedIntegerValue] || ![DKSHA256(bytes) isEqual:file[@"sha256"]]) { *error = DKError(@"Update file hash verification failed."); return NO; }
  }
  @synchronized(DKLock()) {
    NSMutableDictionary *state = DKReadState();
    if (![DKAppVersion() isEqual:appVersion] || version <= [state[@"highest"] integerValue]) { *error = DKError(@"This update is outdated."); return NO; }
    if ([state[@"attempting"] integerValue] > 0) { *error = DKError(@"Wait for the current update launch to be confirmed."); return NO; }
    if (!DKPrepareRoot(error)) return NO;
    DKCleanup(state);
    NSURL *staging = [DKRoot() URLByAppendingPathComponent:[@"staging-" stringByAppendingString:NSUUID.UUID.UUIDString] isDirectory:YES];
    NSFileManager *manager = NSFileManager.defaultManager;
    if (![manager createDirectoryAtURL:staging withIntermediateDirectories:NO attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:error]) return NO;
    BOOL success = YES;
    for (NSString *path in entries) {
      NSURL *url = [staging URLByAppendingPathComponent:path];
      if (![manager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:error] || ![DKArchiveFile(archive,entries,path) writeToURL:url options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:error]) { success = NO; break; }
    }
    if (success) success = DKVerifyDirectory(staging,version,error);
    NSURL *destination = DKVersionDirectory(version);
    if (success) success = [manager createDirectoryAtURL:destination.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:error];
    if (success && [manager fileExistsAtPath:destination.path]) success = [manager removeItemAtURL:destination error:error];
    if (success) success = [manager moveItemAtURL:staging toURL:destination error:error];
    BOOL promoted = success;
    if (success) {
      state[@"pending"] = @(version);
      state[@"highest"] = @(version);
      success = DKWriteState(state,error);
      if (success) DKCleanup(state);
    }
    if (!success) {
      [manager removeItemAtURL:staging error:nil];
      // The state file is the commit point. A failed atomic save must not
      // leave a promoted but unreferenced patch occupying device storage.
      if (promoted) [manager removeItemAtURL:destination error:nil];
    }
    return success;
  }
}

static BOOL DKSafeHTTPS(NSURL *url) {
  if (!url || ![url.scheme.lowercaseString isEqual:@"https"] || !url.host.length || url.user.length || url.password.length || url.fragment.length || (url.port && url.port.integerValue != 443)) return NO;
  NSString *host = url.host.lowercaseString;
  if ([host isEqual:@"localhost"] || [host hasSuffix:@".localhost"] || [host hasSuffix:@".local"] || host.length > 253) return NO;
  NSRegularExpression *domain = [NSRegularExpression regularExpressionWithPattern:@"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$" options:0 error:nil];
  return [domain numberOfMatchesInString:host options:0 range:NSMakeRange(0,host.length)] == 1;
}

@interface DKUpdateDownload : NSObject <NSURLSessionDataDelegate,NSURLSessionTaskDelegate>
@property(nonatomic,strong) NSURLSession *session;
@property(nonatomic,strong) NSMutableData *bytes;
@property(nonatomic,strong) NSError *failure;
@property(nonatomic,copy) void (^progress)(NSUInteger,int64_t);
@property(nonatomic,copy) void (^completion)(NSData *,NSError *);
@property(nonatomic) int64_t expected;
@property(nonatomic) NSUInteger redirects;
@property(nonatomic) NSTimeInterval lastProgress;
@property(nonatomic,copy) NSString *originalHost;
- (void)start:(NSURL *)url;
@end

@implementation DKUpdateDownload
- (void)start:(NSURL *)url {
  self.bytes = [NSMutableData data];
  self.originalHost = url.host.lowercaseString;
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.timeoutIntervalForRequest = 60;
  configuration.timeoutIntervalForResource = 300;
  configuration.URLCache = nil;
  configuration.HTTPCookieStorage = nil;
  configuration.HTTPShouldSetCookies = NO;
  NSOperationQueue *queue = [NSOperationQueue new];
  queue.maxConcurrentOperationCount = 1;
  self.session = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:queue];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:60];
  [request setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
  [[self.session dataTaskWithRequest:request] resume];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler {
  if (++self.redirects > 5 || !DKSafeHTTPS(request.URL) || ![request.URL.host.lowercaseString isEqual:self.originalHost]) { self.failure = DKError(@"Unsafe update redirect."); completionHandler(nil); [task cancel]; }
  else completionHandler(request);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  self.expected = response.expectedContentLength;
  if (![response isKindOfClass:NSHTTPURLResponse.class] || ((NSHTTPURLResponse *)response).statusCode != 200 || !DKSafeHTTPS(response.URL) || ![response.URL.host.lowercaseString isEqual:self.originalHost] || self.expected > (int64_t)DKMaxZipSize) {
    self.failure = DKError(@"Update server returned an invalid response.");
    completionHandler(NSURLSessionResponseCancel);
  } else completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  if (data.length > DKMaxZipSize-self.bytes.length) { self.failure = DKError(@"Update ZIP exceeds the download limit."); [task cancel]; return; }
  [self.bytes appendData:data];
  NSTimeInterval now = NSDate.timeIntervalSinceReferenceDate;
  if (now-self.lastProgress >= 0.2) { self.lastProgress = now; if (self.progress) self.progress(self.bytes.length,MAX((int64_t)0,self.expected)); }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (!error && !self.failure && self.expected >= 0 && self.expected != (int64_t)self.bytes.length) self.failure = DKError(@"Update download length mismatch.");
  if (self.progress) self.progress(self.bytes.length,MAX((int64_t)0,self.expected));
  if (self.completion) self.completion(self.bytes,self.failure ?: error);
  [self.session finishTasksAndInvalidate];
  self.session = nil;
  self.progress = nil;
  self.completion = nil;
}
@end

@interface DreamKeyUpdates : RCTEventEmitter <RCTBridgeModule>
@property(atomic,strong) DKUpdateDownload *download;
@property(atomic) BOOL observing;
@property(atomic) BOOL invalidated;
@end

@implementation DreamKeyUpdates
RCT_EXPORT_MODULE(DreamKeyUpdates)
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.dreamkey.wallet.updates", DISPATCH_QUEUE_SERIAL); });
  return queue;
}
- (NSArray<NSString *> *)supportedEvents { return @[@"DreamKeyUpdateProgress"]; }
- (void)startObserving { self.observing = YES; }
- (void)stopObserving { self.observing = NO; }
- (void)invalidate {
  @synchronized(DKLock()) {
    // A completion may already be queued when the bridge is destroyed. Mark
    // that instance first so queued callbacks cannot stage an obsolete patch.
    self.invalidated = YES;
    self.observing = NO;
    [self.download.session invalidateAndCancel];
    self.download = nil;
  }
  [super invalidate];
}

RCT_REMAP_METHOD(getState, getStateWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @synchronized(DKLock()) {
    NSMutableDictionary *state = DKReadState();
    // Reading state (for example in About) must not consume the startup notice.
    // The UI explicitly acknowledges it only after the notice is presented.
    resolve(@{@"appVersion":DKAppVersion(), @"bundleVersion":@(DKSelectedVersion), @"pendingBundleVersion":state[@"pending"] ?: @0, @"highestBundleVersion":state[@"highest"] ?: @0, @"failedBundleVersion":state[@"failed"] ?: @0, @"rollback":@([state[@"rollback"] boolValue]), @"supported":@(DKSupported()), @"apkReady":@NO, @"apkVersion":@""});
  }
}

RCT_REMAP_METHOD(acknowledgeRollback, acknowledgeRollbackWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @synchronized(DKLock()) {
    NSMutableDictionary *state = DKReadState();
    if ([state[@"rollback"] boolValue]) {
      state[@"rollback"] = @NO;
      NSError *error = nil;
      if (!DKWriteState(state,&error)) { reject(@"E_UPDATE_VERIFY",error.localizedDescription ?: @"Unable to acknowledge the rollback notice.",error); return; }
    }
    resolve(nil);
  }
}

RCT_REMAP_METHOD(stageBundle, stageBundle:(NSString *)urlString appVersion:(NSString *)appVersion bundleVersion:(nonnull NSNumber *)bundleVersion resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!DKSupported()) { reject(@"E_UPDATE_UNSUPPORTED",@"OTA updates are unavailable in Debug builds.",nil); return; }
  NSURL *url = [NSURL URLWithString:urlString];
  NSRegularExpression *versionPattern = [NSRegularExpression regularExpressionWithPattern:@"^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$" options:0 error:nil];
  BOOL validAppVersion = [appVersion isKindOfClass:NSString.class] && appVersion.length <= 50 && [versionPattern numberOfMatchesInString:appVersion options:0 range:NSMakeRange(0,appVersion.length)] == 1;
  if (!DKSafeHTTPS(url)) { reject(@"E_UPDATE_URL",@"Invalid update HTTPS URL.",nil); return; }
  if (!validAppVersion || ![appVersion isEqual:DKAppVersion()] || !DKPositiveInteger(bundleVersion)) { reject(@"E_UPDATE_VERSION",@"Invalid update target version.",nil); return; }
  if (self.download) { reject(@"E_UPDATE_BUSY",@"An update download is already running.",nil); return; }
  @synchronized(DKLock()) {
    NSMutableDictionary *state = DKReadState();
    if ([state[@"attempting"] integerValue] > 0) { reject(@"E_UPDATE_BUSY",@"Wait for the current update launch to be confirmed.",nil); return; }
    if (bundleVersion.integerValue <= [state[@"highest"] integerValue]) { reject(@"E_UPDATE_VERSION",@"This update was already staged or rejected after launch.",nil); return; }
  }
  DKUpdateDownload *download = [DKUpdateDownload new];
  __weak DreamKeyUpdates *weakSelf = self;
  download.progress = ^(NSUInteger received, int64_t total) {
    DreamKeyUpdates *strongSelf = weakSelf;
    if (!strongSelf) return;
    dispatch_async(strongSelf.methodQueue, ^{ if (!strongSelf.invalidated && strongSelf.observing) [strongSelf sendEventWithName:@"DreamKeyUpdateProgress" body:@{@"kind":@"bundle",@"received":@(received),@"total":@(total)}]; });
  };
  download.completion = ^(NSData *archive,NSError *networkError) {
    DreamKeyUpdates *strongSelf = weakSelf;
    if (!strongSelf) return;
    dispatch_async(strongSelf.methodQueue, ^{
      @synchronized(DKLock()) {
        if (strongSelf.invalidated) return;
        NSError *error = networkError;
        BOOL success = !error && DKStageArchive(archive,appVersion,bundleVersion.integerValue,&error);
        strongSelf.download = nil;
        if (success) resolve(nil);
        else reject(networkError ? @"E_UPDATE_DOWNLOAD" : @"E_UPDATE_VERIFY",error.localizedDescription ?: @"Unable to stage update.",error);
      }
    });
  };
  @synchronized(DKLock()) {
    if (self.invalidated) { reject(@"E_UPDATE_NATIVE",@"The update bridge is unavailable.",nil); return; }
    self.download = download;
    [download start:url];
  }
}

RCT_REMAP_METHOD(markLaunchSuccessful, markLaunchSuccessfulWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  @synchronized(DKLock()) {
    NSMutableDictionary *state = DKReadState();
    if (DKSelectedVersion > 0 && [state[@"attempting"] integerValue] == DKSelectedVersion) {
      NSError *error = nil;
      if (!DKVerifyDirectory(DKVersionDirectory(DKSelectedVersion),DKSelectedVersion,&error)) { reject(@"E_UPDATE_VERIFY",error.localizedDescription ?: @"Unable to verify the running update.",error); return; }
      state[@"lastGood"] = @(DKSelectedVersion);
      state[@"attempting"] = @0;
      state[@"rollback"] = @NO;
      if (!DKWriteState(state,&error)) { reject(@"E_UPDATE_VERIFY",error.localizedDescription,error); return; }
      DKCleanup(state);
    }
    resolve(nil);
  }
}
@end
