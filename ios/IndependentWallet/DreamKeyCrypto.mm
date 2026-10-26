#import <CommonCrypto/CommonKeyDerivation.h>
#import <React/RCTBridgeModule.h>
#import <math.h>

static void DKClearBytes(void *bytes, NSUInteger length)
{
  volatile unsigned char *cursor = (volatile unsigned char *)bytes;
  while (length-- > 0) *cursor++ = 0;
}

static int DKHexDigit(unichar value)
{
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static NSMutableData *DKDecodeHex(NSString *value, NSUInteger minimumBytes, NSUInteger maximumBytes)
{
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSUInteger start = [value hasPrefix:@"0x"] ? 2 : 0;
  NSUInteger length = value.length - start;
  if ((length & 1) != 0 || length < minimumBytes * 2 || length > maximumBytes * 2) return nil;
  NSMutableData *data = [NSMutableData dataWithLength:length / 2];
  unsigned char *bytes = (unsigned char *)data.mutableBytes;
  for (NSUInteger index = 0; index < data.length; index++) {
    int high = DKHexDigit([value characterAtIndex:start + index * 2]);
    int low = DKHexDigit([value characterAtIndex:start + index * 2 + 1]);
    if (high < 0 || low < 0) {
      DKClearBytes(data.mutableBytes, data.length);
      return nil;
    }
    bytes[index] = (unsigned char)((high << 4) | low);
  }
  return data;
}

@interface DreamKeyCrypto : NSObject <RCTBridgeModule>
@end

@implementation DreamKeyCrypto {
  dispatch_queue_t _cryptoQueue;
}

RCT_EXPORT_MODULE(DreamKeyCrypto)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _cryptoQueue = dispatch_queue_create("app.dreamkey.password-crypto", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (dispatch_queue_t)methodQueue
{
  return _cryptoQueue;
}

RCT_EXPORT_METHOD(derivePasswordVerifier:(NSString *)passwordUtf8Hex
                  saltHex:(NSString *)saltHex
                  iterations:(double)iterations
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!isfinite(iterations) || iterations != 120000) {
    reject(@"E_CRYPTO_PARAMETERS", @"Invalid password derivation parameters", nil);
    return;
  }
  NSMutableData *password = DKDecodeHex(passwordUtf8Hex, 1, 4096);
  NSMutableData *salt = DKDecodeHex(saltHex, 16, 16);
  if (!password || !salt) {
    if (password) DKClearBytes(password.mutableBytes, password.length);
    if (salt) DKClearBytes(salt.mutableBytes, salt.length);
    reject(@"E_CRYPTO_PARAMETERS", @"Invalid password derivation parameters", nil);
    return;
  }
  unsigned char derived[32] = {0};
  int result = CCKeyDerivationPBKDF(kCCPBKDF2,
                                    (const char *)password.bytes, password.length,
                                    (const unsigned char *)salt.bytes, salt.length,
                                    kCCPRFHmacAlgSHA256, 120000,
                                    derived, sizeof(derived));
  DKClearBytes(password.mutableBytes, password.length);
  DKClearBytes(salt.mutableBytes, salt.length);
  if (result != kCCSuccess) {
    DKClearBytes(derived, sizeof(derived));
    reject(@"E_CRYPTO_DERIVE", @"Unable to derive password verifier", nil);
    return;
  }
  const char *digits = "0123456789abcdef";
  char encoded[67] = {'0', 'x'};
  for (NSUInteger index = 0; index < sizeof(derived); index++) {
    encoded[index * 2 + 2] = digits[derived[index] >> 4];
    encoded[index * 2 + 3] = digits[derived[index] & 0x0f];
  }
  NSString *verifier = [[NSString alloc] initWithBytes:encoded length:66 encoding:NSASCIIStringEncoding];
  DKClearBytes(derived, sizeof(derived));
  DKClearBytes(encoded, sizeof(encoded));
  resolve(verifier);
}

@end
