#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol ArdiaPasskeyPage <NSObject>
@property(nonatomic, readonly, copy) NSString *passkeyProfile;
@property(nonatomic, readonly) BOOL passkeyPrivate;
@property(nonatomic, readonly) NSInteger passkeyDocument;
@property(nonatomic, readonly, nullable, copy) NSString *passkeyTopOrigin;
@property(nonatomic, readonly) BOOL passkeyVisible;
- (void)passkeyConfirm:(NSString *)nonce pageId:(NSInteger)pageId done:(void (^)(BOOL stillPending))done;
- (void)passkeyReply:(NSString *)nonce pageId:(NSInteger)pageId reply:(NSDictionary<NSString *, id> *)reply;
- (void)passkeyEmit:(NSString *)name payload:(NSDictionary<NSString *, id> *)payload;
@end


NS_ASSUME_NONNULL_END
