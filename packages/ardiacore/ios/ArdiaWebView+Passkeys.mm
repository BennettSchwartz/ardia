#import "ArdiaWebViewInternal.h"

#import <objc/runtime.h>

#import "ArdiaHost.h"
#import "ArdiaPasskeys.h"

NS_ASSUME_NONNULL_BEGIN
@interface ArdiaPasskeyCoordinator : NSObject
@property(class, nonatomic, readonly) ArdiaPasskeyCoordinator *shared;
- (void)request:(NSString *)op
        options:(NSString *)optionsJSON
          nonce:(NSString *)nonce
         pageId:(NSInteger)pageId
         origin:(nullable NSString *)origin
           main:(BOOL)main
           page:(id<ArdiaPasskeyPage>)page;
- (void)cancel:(NSString *)nonce pageId:(NSInteger)pageId page:(id<ArdiaPasskeyPage>)page;
- (void)pageChanged:(id<ArdiaPasskeyPage>)page;
- (BOOL)providesForProfile:(NSString *)profile;
@end
NS_ASSUME_NONNULL_END

static char kPasskeyConfirmsKey;

static NSString *PasskeyJSON(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
}

static NSString *ConfirmKey(NSString *nonce, NSInteger pageId) {
  return [NSString stringWithFormat:@"%@:%ld", nonce, (long)pageId];
}

@interface ArdiaWebView (PasskeyPage) <ArdiaPasskeyPage>
@end

@implementation ArdiaWebView (PasskeyPage)

- (NSMutableDictionary<NSString *, void (^)(BOOL)> *)passkeyConfirms {
  NSMutableDictionary *confirms = objc_getAssociatedObject(self, &kPasskeyConfirmsKey);
  if (!confirms) {
    confirms = [NSMutableDictionary dictionary];
    objc_setAssociatedObject(self, &kPasskeyConfirmsKey, confirms, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return confirms;
}

- (NSString *)passkeyProfile {
  return _profile ?: @"";
}

- (BOOL)passkeyPrivate {
  return _tab.profile.offTheRecord || [ArdiaHost isPrivateProfile:_profile ?: @""];
}

- (NSInteger)passkeyDocument {
  return _tab && !_tab.closed ? _tab.committedDocumentCount : -1;
}

- (NSString *)passkeyTopOrigin {
  return _tab && !_tab.closed ? _tab.committedOrigin : nil;
}

- (BOOL)passkeyVisible {
  return _tab && !_tab.closed && _visible && self.window.isKeyWindow && self.window.isVisible && !self.isHiddenOrHasHiddenAncestor;
}

- (void)passkeyConfirm:(NSString *)nonce pageId:(NSInteger)pageId done:(void (^)(BOOL))done {
  NSString *key = ConfirmKey(nonce, pageId);
  self.passkeyConfirms[key] = [done copy];
  [self callFrame:@"" kind:@"passkeyAck" json:PasskeyJSON(@{@"nonce" : nonce, @"id" : @(pageId)})];
  __weak ArdiaWebView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    void (^late)(BOOL) = weakSelf.passkeyConfirms[key];
    if (!late) return;
    [weakSelf.passkeyConfirms removeObjectForKey:key];
    late(NO);
  });
}

- (void)passkeyReply:(NSString *)nonce pageId:(NSInteger)pageId reply:(NSDictionary<NSString *, id> *)reply {
  [self.passkeyConfirms removeObjectForKey:ConfirmKey(nonce, pageId)];
  [self callFrame:@"" kind:@"passkeyReply" json:PasskeyJSON(@{@"nonce" : nonce, @"id" : @(pageId), @"reply" : reply ?: @{}})];
}

- (void)passkeyEmit:(NSString *)name payload:(NSDictionary<NSString *, id> *)payload {
  [self emit:name payload:payload];
}

@end

@implementation ArdiaWebView (Passkeys)

+ (void)pushPasskeyConfigEverywhere {
  for (ArdiaWebView *view in ardia_web_view::LiveViews().allObjects) [view pushPasskeyConfig];
}

- (BOOL)handlePasskeyMessage:(NSString *)kind dict:(NSDictionary *)dict main:(BOOL)main origin:(NSString *)verifiedOrigin {
  if (![kind hasPrefix:@"passkey"]) return NO;
  NSString *nonce = [dict[@"nonce"] isKindOfClass:NSString.class] ? dict[@"nonce"] : nil;
  NSNumber *number = [dict[@"id"] isKindOfClass:NSNumber.class] ? dict[@"id"] : nil;
  const NSInteger pageId = number.integerValue;
  if (!nonce.length || nonce.length > 64 || pageId < 1 || pageId > INT_MAX) return YES;
  if ([kind isEqualToString:@"passkeyRequest"]) {
    NSString *op = [dict[@"op"] isKindOfClass:NSString.class] ? dict[@"op"] : @"";
    NSDictionary *options = [dict[@"options"] isKindOfClass:NSDictionary.class] ? dict[@"options"] : @{};
    NSString *origin = verifiedOrigin.length && ![verifiedOrigin isEqualToString:@"null"] ? verifiedOrigin : nil;
    [ArdiaPasskeyCoordinator.shared request:op options:PasskeyJSON(options) nonce:nonce pageId:pageId origin:origin main:main page:self];
  } else if ([kind isEqualToString:@"passkeyAckOk"]) {
    if (!main) return YES;
    NSString *key = ConfirmKey(nonce, pageId);
    void (^done)(BOOL) = self.passkeyConfirms[key];
    if (!done) return YES;
    [self.passkeyConfirms removeObjectForKey:key];
    done([dict[@"pending"] isEqual:@YES]);
  } else if ([kind isEqualToString:@"passkeyCancel"]) {
    [ArdiaPasskeyCoordinator.shared cancel:nonce pageId:pageId page:self];
  }
  return YES;
}

- (void)pushPasskeyConfig {
  if (!_tab || _tab.closed) return;
  BOOL on = [ArdiaPasskeyCoordinator.shared providesForProfile:_profile ?: @""];
  [self callFrame:@"" kind:@"passkeyConfig" json:on ? @"{\"on\":true}" : @"{\"on\":false}"];
}

- (void)passkeyDocumentChanged {
  [ArdiaPasskeyCoordinator.shared pageChanged:self];
}

@end
