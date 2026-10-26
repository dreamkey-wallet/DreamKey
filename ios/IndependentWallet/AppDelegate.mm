#import "AppDelegate.h"
#import "DreamKeyUpdates.h"

#import <React/RCTBundleURLProvider.h>

@interface AppDelegate ()
@property (nonatomic, strong) UIWindow *privacyWindow;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"IndependentWallet";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return DreamKeyUpdatesBundleURL() ?: [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

- (void)applicationWillResignActive:(UIApplication *)application
{
  // Cover every presented controller before iOS takes the task-switcher snapshot.
  // This only affects presentation; biometric prompts do not invalidate a session.
  if (!self.privacyWindow) {
    UIWindowScene *scene = self.window.windowScene;
    self.privacyWindow = scene ? [[UIWindow alloc] initWithWindowScene:scene]
                               : [[UIWindow alloc] initWithFrame:self.window.bounds];
    self.privacyWindow.windowLevel = UIWindowLevelAlert + 1;
    UIViewController *cover = [UIViewController new];
    cover.view.backgroundColor = [UIColor colorWithRed:12.0/255 green:18.0/255 blue:36.0/255 alpha:1];
    self.privacyWindow.rootViewController = cover;
  }
  self.privacyWindow.hidden = NO;
}

- (void)applicationDidBecomeActive:(UIApplication *)application
{
  self.privacyWindow.hidden = YES;
}

@end
