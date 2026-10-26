#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface DreamKeyAppInfo : NSObject <RCTBridgeModule>
@end

@implementation DreamKeyAppInfo

RCT_EXPORT_MODULE(DreamKeyAppInfo)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  NSString *versionName = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
  return @{@"versionName": versionName ?: @""};
}

@end
