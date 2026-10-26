#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

static const NSUInteger DKFaviconMaxKeyLength = 4096;
static const NSUInteger DKFaviconMaxValueBytes = 768 * 1024;
static const NSUInteger DKFaviconMaxEntries = 60;
static const unsigned long long DKFaviconMaxCacheBytes = 8 * 1024 * 1024;

static BOOL DKFaviconMissingFile(NSError *error)
{
  return [error.domain isEqualToString:NSCocoaErrorDomain]
      && (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError);
}

static BOOL DKFaviconValidJSON(NSData *data)
{
  if (!data.length || data.length > DKFaviconMaxValueBytes) return NO;
  NSError *error = nil;
  [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:&error];
  return error == nil;
}

@interface DreamKeyFaviconCache : NSObject <RCTBridgeModule>
@end

@implementation DreamKeyFaviconCache {
  dispatch_queue_t _cacheQueue;
}

RCT_EXPORT_MODULE(DreamKeyFaviconCache)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _cacheQueue = dispatch_queue_create("app.dreamkey.favicon-cache", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return _cacheQueue;
}

- (NSURL *)cacheDirectory:(NSError **)error
{
  NSFileManager *files = [NSFileManager defaultManager];
  NSURL *caches = [[files URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
  if (!caches) return nil;
  NSURL *directory = [caches URLByAppendingPathComponent:@"dapp-favicons" isDirectory:YES];
  if (![files createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:error]) {
    return nil;
  }
  return directory;
}

- (NSString *)filenameForKey:(NSString *)key
{
  NSData *data = [key dataUsingEncoding:NSUTF8StringEncoding];
  if (!data) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *filename = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2 + 5];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [filename appendFormat:@"%02x", digest[index]];
  }
  [filename appendString:@".json"];
  return filename;
}

- (BOOL)trimDirectory:(NSURL *)directory error:(NSError **)error
{
  NSFileManager *files = [NSFileManager defaultManager];
  NSArray<NSURL *> *urls = [files contentsOfDirectoryAtURL:directory
                             includingPropertiesForKeys:nil options:0 error:error];
  if (!urls) return NO;
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  unsigned long long totalBytes = 0;
  for (NSURL *url in urls) {
    NSDictionary *attributes = [files attributesOfItemAtPath:url.path error:error];
    if (!attributes) return NO;
    // This directory is dedicated to disposable favicon records.
    if (![attributes[NSFileType] isEqualToString:NSFileTypeRegular]
        || [attributes[NSFileSize] unsignedLongLongValue] > DKFaviconMaxValueBytes) {
      if (![files removeItemAtURL:url error:error]) return NO;
      continue;
    }
    unsigned long long size = [attributes[NSFileSize] unsignedLongLongValue];
    totalBytes += size;
    [entries addObject:@{@"url": url, @"size": @(size),
                         @"modified": attributes[NSFileModificationDate] ?: [NSDate distantPast]}];
  }
  [entries sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"modified"] compare:right[@"modified"]];
  }];
  NSUInteger remaining = entries.count;
  for (NSDictionary *entry in entries) {
    if (remaining <= DKFaviconMaxEntries && totalBytes <= DKFaviconMaxCacheBytes) break;
    if (![files removeItemAtURL:entry[@"url"] error:error]) return NO;
    remaining--;
    totalBytes -= [entry[@"size"] unsignedLongLongValue];
  }
  return YES;
}

RCT_EXPORT_METHOD(read:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (![key isKindOfClass:[NSString class]] || key.length > DKFaviconMaxKeyLength) {
    reject(@"E_FAVICON_KEY", @"Invalid favicon cache key", nil);
    return;
  }
  NSString *filename = [self filenameForKey:key];
  if (!filename) {
    reject(@"E_FAVICON_KEY", @"Invalid favicon cache key", nil);
    return;
  }
  NSError *error = nil;
  NSURL *directory = [self cacheDirectory:&error];
  if (!directory) {
    reject(@"E_FAVICON_READ", @"Unable to read favicon cache", nil);
    return;
  }
  NSURL *url = [directory URLByAppendingPathComponent:filename];
  NSFileManager *files = [NSFileManager defaultManager];
  NSDictionary *attributes = [files attributesOfItemAtPath:url.path error:&error];
  if (!attributes) {
    if (DKFaviconMissingFile(error)) resolve([NSNull null]);
    else reject(@"E_FAVICON_READ", @"Unable to read favicon cache", nil);
    return;
  }
  if (![attributes[NSFileType] isEqualToString:NSFileTypeRegular]
      || [attributes[NSFileSize] unsignedLongLongValue] > DKFaviconMaxValueBytes) {
    if ([files removeItemAtURL:url error:&error]) resolve([NSNull null]);
    else reject(@"E_FAVICON_READ", @"Unable to read favicon cache", nil);
    return;
  }
  NSData *data = [NSData dataWithContentsOfURL:url options:0 error:&error];
  if (!data) {
    reject(@"E_FAVICON_READ", @"Unable to read favicon cache", nil);
    return;
  }
  NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!value || !DKFaviconValidJSON(data)) {
    if ([files removeItemAtURL:url error:&error]) resolve([NSNull null]);
    else reject(@"E_FAVICON_READ", @"Unable to read favicon cache", nil);
    return;
  }
  if (![files setAttributes:@{NSFileModificationDate: [NSDate date]} ofItemAtPath:url.path error:&error]) {
    reject(@"E_FAVICON_READ", @"Unable to read favicon cache", nil);
    return;
  }
  resolve(value);
}

RCT_EXPORT_METHOD(write:(NSString *)key
                  value:(NSString *)value
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (![key isKindOfClass:[NSString class]] || key.length > DKFaviconMaxKeyLength) {
    reject(@"E_FAVICON_KEY", @"Invalid favicon cache key", nil);
    return;
  }
  // Check character length before allocating the UTF-8 representation.
  if (![value isKindOfClass:[NSString class]] || value.length > DKFaviconMaxValueBytes) {
    reject(@"E_FAVICON_VALUE", @"Invalid favicon cache value", nil);
    return;
  }
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  if (!DKFaviconValidJSON(data)) {
    reject(@"E_FAVICON_VALUE", @"Invalid favicon cache value", nil);
    return;
  }
  NSString *filename = [self filenameForKey:key];
  if (!filename) {
    reject(@"E_FAVICON_KEY", @"Invalid favicon cache key", nil);
    return;
  }
  NSError *error = nil;
  NSURL *directory = [self cacheDirectory:&error];
  if (!directory || ![data writeToURL:[directory URLByAppendingPathComponent:filename]
                            options:NSDataWritingAtomic error:&error]
      || ![self trimDirectory:directory error:&error]) {
    reject(@"E_FAVICON_WRITE", @"Unable to write favicon cache", nil);
    return;
  }
  resolve(@YES);
}

@end
