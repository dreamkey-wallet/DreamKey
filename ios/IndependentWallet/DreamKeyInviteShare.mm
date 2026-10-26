#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <string.h>

static BOOL DKAllowedPngDimension(const unsigned char *bytes)
{
  uint32_t dimension = ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16)
      | ((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
  return dimension > 0 && dimension <= 4096;
}

static BOOL DKValidInvitePng(NSData *data)
{
  static const unsigned char signature[] = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  if (data.length < 33) return NO;
  const unsigned char *bytes = (const unsigned char *)data.bytes;
  // PNG's first chunk is a 13-byte IHDR. Check its dimensions before any image decode.
  return memcmp(bytes, signature, sizeof(signature)) == 0
      && bytes[8] == 0 && bytes[9] == 0 && bytes[10] == 0 && bytes[11] == 13
      && memcmp(bytes + 12, "IHDR", 4) == 0
      && DKAllowedPngDimension(bytes + 16) && DKAllowedPngDimension(bytes + 20);
}

@interface DreamKeyInviteShare : NSObject <RCTBridgeModule>
@end

@implementation DreamKeyInviteShare {
  dispatch_queue_t _shareQueue;
  BOOL _sharing;
}

RCT_EXPORT_MODULE(DreamKeyInviteShare)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _shareQueue = dispatch_queue_create("app.dreamkey.invite-share", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return _shareQueue;
}

RCT_EXPORT_METHOD(shareImage:(NSString *)pngBase64
                  message:(NSString *)message
                  title:(NSString *)title
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!pngBase64.length || pngBase64.length > 16 * 1024 * 1024) {
    reject(@"E_SHARE_IMAGE", @"Invalid invitation image", nil);
    return;
  }
  NSData *pngData = [[NSData alloc] initWithBase64EncodedString:pngBase64 options:0];
  if (!DKValidInvitePng(pngData)) {
    reject(@"E_SHARE_IMAGE", @"Invalid invitation image", nil);
    return;
  }
  UIImage *image = [UIImage imageWithData:pngData];
  if (!image || image.size.width <= 0 || image.size.height <= 0
      || image.size.width * image.scale > 4096 || image.size.height * image.scale > 4096) {
    reject(@"E_SHARE_IMAGE", @"Invalid invitation image dimensions", nil);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = RCTPresentedViewController();
    if (!presenter || !presenter.view.window || presenter.isBeingDismissed || self->_sharing) {
      reject(@"E_SHARE_UNAVAILABLE", @"No active screen for sharing", nil);
      return;
    }
    NSMutableArray *items = [NSMutableArray arrayWithObject:image];
    if (message.length) [items addObject:message];
    UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:items
                                                                    applicationActivities:nil];
    sheet.title = title;
    if (title.length) [sheet setValue:title forKey:@"subject"];
    // An anchor is mandatory on iPad, including when sharing from a modal screen.
    UIPopoverPresentationController *popover = sheet.popoverPresentationController;
    if (popover) {
      popover.sourceView = presenter.view;
      CGRect bounds = presenter.view.bounds;
      popover.sourceRect = CGRectMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds), 1, 1);
      popover.permittedArrowDirections = 0;
    }
    sheet.completionWithItemsHandler = ^(UIActivityType activityType, BOOL completed,
                                        NSArray *returnedItems, NSError *error) {
      self->_sharing = NO;
      if (error) {
        reject(@"E_SHARE_UNAVAILABLE", @"Unable to share invitation image", error);
      } else {
        // Cancellation is an ordinary dismissal, not an error or a sent message.
        resolve(nil);
      }
    };
    self->_sharing = YES;
    [presenter presentViewController:sheet animated:YES completion:nil];
  });
}

@end
